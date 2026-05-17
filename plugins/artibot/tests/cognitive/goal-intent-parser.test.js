import { describe, expect, it } from 'vitest';
import {
  DEFAULT_AUTO_MAX_ITERATIONS,
  parseGoalIntent,
} from '../../lib/cognitive/goal-intent-parser.js';
import { HARD_MAX_ITERATIONS } from '../../lib/autopilot/goal-schema.js';

describe('parseGoalIntent', () => {
  describe('input validation', () => {
    it('returns found=false for empty prompt', () => {
      const r = parseGoalIntent('');
      expect(r.found).toBe(false);
      expect(r.confidence).toBe(0);
    });

    it('returns found=false for null', () => {
      const r = parseGoalIntent(null);
      expect(r.found).toBe(false);
    });

    it('returns found=false for non-string', () => {
      const r = parseGoalIntent(42);
      expect(r.found).toBe(false);
    });

    it('returns found=false for whitespace-only prompt', () => {
      const r = parseGoalIntent('   \n  ');
      expect(r.found).toBe(false);
    });

    it('returns default max iterations on empty', () => {
      const r = parseGoalIntent('');
      expect(r.maxIterations).toBe(DEFAULT_AUTO_MAX_ITERATIONS);
    });
  });

  describe('English markers', () => {
    it('detects "until" marker', () => {
      const r = parseGoalIntent('keep working until tests pass');
      expect(r.found).toBe(true);
      expect(r.condition).toBe('tests pass');
    });

    it('detects "as long as"', () => {
      const r = parseGoalIntent('iterate as long as the build is red');
      expect(r.found).toBe(true);
      expect(r.condition).toContain('build is red');
    });

    it('detects "repeat until"', () => {
      const r = parseGoalIntent('repeat until lint clean');
      expect(r.found).toBe(true);
      expect(r.suggestedValidationCommand).toBe('npm run lint');
    });

    it('detects "iterate until"', () => {
      const r = parseGoalIntent('iterate until build green');
      expect(r.found).toBe(true);
      expect(r.suggestedValidationCommand).toBe('npm run build');
    });

    it('detects "when ... done"', () => {
      const r = parseGoalIntent('stop when refactor is done');
      expect(r.found).toBe(true);
    });
  });

  describe('Korean markers', () => {
    it('detects "조건이 만족할 때까지"', () => {
      const r = parseGoalIntent('테스트가 통과될 조건이 만족할 때까지 반복해줘');
      expect(r.found).toBe(true);
      expect(r.confidence).toBeGreaterThan(0.4);
    });

    it('detects "될 때까지"', () => {
      const r = parseGoalIntent('빌드가 성공할 될 때까지 계속해줘');
      expect(r.found).toBe(true);
    });

    it('detects "되면 멈춰"', () => {
      const r = parseGoalIntent('테스트가 통과되면 멈춰');
      expect(r.found).toBe(true);
    });

    it('detects "계속해서"', () => {
      const r = parseGoalIntent('계속해서 린트가 통과될 때까지 시도해줘');
      expect(r.found).toBe(true);
    });

    it('extracts Korean condition phrase after marker', () => {
      const r = parseGoalIntent('될 때까지 테스트 통과');
      expect(r.found).toBe(true);
      expect(r.condition).toContain('테스트');
    });
  });

  describe('validation command suggestions', () => {
    it('suggests npm test for "tests pass"', () => {
      const r = parseGoalIntent('iterate until tests pass');
      expect(r.suggestedValidationCommand).toBe('npm test');
    });

    it('suggests npm run lint for "lint clean"', () => {
      const r = parseGoalIntent('repeat until lint clean');
      expect(r.suggestedValidationCommand).toBe('npm run lint');
    });

    it('suggests npm run build for "build green"', () => {
      const r = parseGoalIntent('keep going until build green');
      expect(r.suggestedValidationCommand).toBe('npm run build');
    });

    it('suggests npm run ci for "all checks pass"', () => {
      const r = parseGoalIntent('iterate until all checks pass');
      expect(r.suggestedValidationCommand).toBe('npm run ci');
    });

    it('suggests npm run typecheck for "typecheck"', () => {
      const r = parseGoalIntent('keep going until typecheck succeeds');
      expect(r.suggestedValidationCommand).toBe('npm run typecheck');
    });

    it('returns null command for free-form condition', () => {
      const r = parseGoalIntent('iterate until the user is happy');
      expect(r.found).toBe(true);
      expect(r.suggestedValidationCommand).toBeNull();
    });
  });

  describe('iteration cap', () => {
    it('uses default when not specified', () => {
      const r = parseGoalIntent('iterate until tests pass');
      expect(r.maxIterations).toBe(DEFAULT_AUTO_MAX_ITERATIONS);
    });

    it('respects explicit "max N iterations"', () => {
      const r = parseGoalIntent('iterate until tests pass, max 3 iterations');
      expect(r.maxIterations).toBe(3);
    });

    it('respects Korean "N번 반복"', () => {
      const r = parseGoalIntent('테스트 될 때까지 7번 반복해줘');
      expect(r.maxIterations).toBe(7);
    });

    it('caps at HARD_MAX_ITERATIONS', () => {
      const r = parseGoalIntent('iterate until tests pass, max 50 iterations');
      expect(r.maxIterations).toBe(HARD_MAX_ITERATIONS);
    });

    it('respects "최대 N번"', () => {
      const r = parseGoalIntent('빌드 될 때까지 최대 4번 시도');
      expect(r.maxIterations).toBe(4);
    });
  });

  describe('confidence scoring', () => {
    it('high confidence for strong marker + sane length', () => {
      const r = parseGoalIntent('iterate until tests pass');
      expect(r.confidence).toBeGreaterThanOrEqual(0.5);
    });

    it('low confidence for weak marker alone', () => {
      const r = parseGoalIntent('repeat the experiment');
      // "repeat" is weak; condition "the experiment" is short
      expect(r.confidence).toBeLessThan(0.7);
    });

    it('confidence in 0..1 range', () => {
      const r = parseGoalIntent('iterate until all checks pass and build green');
      expect(r.confidence).toBeGreaterThanOrEqual(0);
      expect(r.confidence).toBeLessThanOrEqual(1);
    });
  });

  describe('no-intent prompts', () => {
    it('plain question has no goal intent', () => {
      const r = parseGoalIntent('what is the capital of France?');
      expect(r.found).toBe(false);
    });

    it('factual statement has no goal intent', () => {
      const r = parseGoalIntent('the build was successful yesterday');
      expect(r.found).toBe(false);
    });

    it('greeting has no goal intent', () => {
      const r = parseGoalIntent('hello, how are you?');
      expect(r.found).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('marker with no tail returns found=false', () => {
      const r = parseGoalIntent('until');
      expect(r.found).toBe(false);
    });

    it('bounds condition at sentence break', () => {
      const r = parseGoalIntent('iterate until tests pass. Then write docs.');
      expect(r.condition).toBe('tests pass');
    });

    it('handles trailing punctuation in condition', () => {
      const r = parseGoalIntent('repeat until lint clean!');
      expect(r.condition).toBe('lint clean');
    });

    it('returns marker string for debugging', () => {
      const r = parseGoalIntent('iterate until tests pass');
      expect(r.marker).toBeTruthy();
      expect(typeof r.marker).toBe('string');
    });
  });
});
