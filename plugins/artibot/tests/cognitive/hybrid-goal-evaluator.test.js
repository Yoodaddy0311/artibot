import { describe, expect, it, vi } from 'vitest';
import {
  evaluateHybrid,
  HAIKU_TRUST_THRESHOLD,
} from '../../lib/cognitive/hybrid-goal-evaluator.js';

function haikuOf(met, confidence) {
  return () => ({ met, confidence });
}

function validationOf(exitCode, stdout = '', stderr = '') {
  return () => ({ exitCode, stdout, stderr });
}

describe('evaluateHybrid', () => {
  describe('input validation', () => {
    it('errors on empty condition', () => {
      const r = evaluateHybrid('', {}, {});
      expect(r.met).toBe(false);
      expect(r.confidence).toBe(0);
      expect(r.reasoning).toMatch(/empty/);
    });

    it('errors on null condition', () => {
      const r = evaluateHybrid(null, {}, {});
      expect(r.met).toBe(false);
    });

    it('errors on whitespace-only condition', () => {
      const r = evaluateHybrid('   ', {}, {});
      expect(r.met).toBe(false);
    });

    it('errors when no Haiku and no validation', () => {
      const r = evaluateHybrid('tests pass', {}, {});
      expect(r.met).toBe(false);
      expect(r.reasoning).toMatch(/no Haiku judge/);
    });
  });

  describe('Haiku high-confidence trust', () => {
    it('trusts Haiku when confidence >= threshold (met)', () => {
      const r = evaluateHybrid('tests pass', {}, {
        runHaikuJudge: haikuOf(true, 0.95),
      });
      expect(r.met).toBe(true);
      expect(r.evaluator).toBe('haiku');
      expect(r.confidence).toBeGreaterThanOrEqual(0.85);
    });

    it('trusts Haiku when confidence >= threshold (not met)', () => {
      const r = evaluateHybrid('tests pass', {}, {
        runHaikuJudge: haikuOf(false, 0.9),
      });
      expect(r.met).toBe(false);
      expect(r.evaluator).toBe('haiku');
    });

    it('does NOT call validation when Haiku confident', () => {
      const spy = vi.fn();
      evaluateHybrid('tests pass', {}, {
        runHaikuJudge: haikuOf(true, 0.99),
        validationCommand: 'npm test',
        runValidation: spy,
      });
      expect(spy).not.toHaveBeenCalled();
    });

    it('respects custom haikuTrustThreshold', () => {
      const r = evaluateHybrid('tests pass', {}, {
        runHaikuJudge: haikuOf(true, 0.6),
        haikuTrustThreshold: 0.5,
      });
      expect(r.evaluator).toBe('haiku');
    });

    it('exposes HAIKU_TRUST_THRESHOLD constant', () => {
      expect(typeof HAIKU_TRUST_THRESHOLD).toBe('number');
      expect(HAIKU_TRUST_THRESHOLD).toBeGreaterThan(0);
      expect(HAIKU_TRUST_THRESHOLD).toBeLessThanOrEqual(1);
    });
  });

  describe('validation fallback (low Haiku confidence)', () => {
    it('runs validation when Haiku confidence below threshold', () => {
      const spy = vi.fn(validationOf(0));
      const r = evaluateHybrid('tests pass', {}, {
        runHaikuJudge: haikuOf(true, 0.5),
        validationCommand: 'npm test',
        runValidation: spy,
      });
      expect(spy).toHaveBeenCalledOnce();
      expect(r.met).toBe(true);
    });

    it('returns validation-only when no Haiku at all', () => {
      const r = evaluateHybrid('tests pass', {}, {
        validationCommand: 'npm test',
        runValidation: validationOf(0),
      });
      expect(r.evaluator).toBe('validation');
      expect(r.met).toBe(true);
    });

    it('returns met=false on non-zero exit', () => {
      const r = evaluateHybrid('tests pass', {}, {
        validationCommand: 'npm test',
        runValidation: validationOf(1, '', 'failed'),
      });
      expect(r.met).toBe(false);
    });
  });

  describe('consensus', () => {
    it('returns consensus when both agree (met=true)', () => {
      const r = evaluateHybrid('tests pass', {}, {
        runHaikuJudge: haikuOf(true, 0.6),
        validationCommand: 'npm test',
        runValidation: validationOf(0),
      });
      expect(r.evaluator).toBe('consensus');
      expect(r.met).toBe(true);
      expect(r.confidence).toBe(1.0);
    });

    it('returns consensus when both agree (met=false)', () => {
      const r = evaluateHybrid('tests pass', {}, {
        runHaikuJudge: haikuOf(false, 0.6),
        validationCommand: 'npm test',
        runValidation: validationOf(1),
      });
      expect(r.evaluator).toBe('consensus');
      expect(r.met).toBe(false);
    });
  });

  describe('conflict resolution', () => {
    it('trusts validation when Haiku says met but exit nonzero', () => {
      const r = evaluateHybrid('tests pass', {}, {
        runHaikuJudge: haikuOf(true, 0.6),
        validationCommand: 'npm test',
        runValidation: validationOf(1),
      });
      expect(r.met).toBe(false);
      expect(r.evaluator).toBe('validation');
      expect(r.reasoning).toMatch(/conflict/);
    });

    it('trusts validation when Haiku says not-met but exit zero', () => {
      const r = evaluateHybrid('tests pass', {}, {
        runHaikuJudge: haikuOf(false, 0.6),
        validationCommand: 'npm test',
        runValidation: validationOf(0),
      });
      expect(r.met).toBe(true);
      expect(r.evaluator).toBe('validation');
    });
  });

  describe('error handling', () => {
    it('handles Haiku throwing and falls back to validation', () => {
      const r = evaluateHybrid('tests pass', {}, {
        runHaikuJudge: () => { throw new Error('haiku down'); },
        validationCommand: 'npm test',
        runValidation: validationOf(0),
      });
      expect(r.evaluator).toBe('validation');
      expect(r.met).toBe(true);
    });

    it('handles validation throwing', () => {
      const r = evaluateHybrid('tests pass', {}, {
        runHaikuJudge: haikuOf(true, 0.5),
        validationCommand: 'npm test',
        runValidation: () => { throw new Error('exec failed'); },
      });
      expect(r.met).toBe(false);
      expect(r.reasoning).toMatch(/validation threw/);
    });

    it('normalizes Haiku confidence > 1', () => {
      const r = evaluateHybrid('tests pass', {}, {
        runHaikuJudge: () => ({ met: true, confidence: 2.5 }),
      });
      expect(r.confidence).toBeLessThanOrEqual(1);
    });

    it('normalizes Haiku negative confidence', () => {
      const r = evaluateHybrid('tests pass', {}, {
        runHaikuJudge: () => ({ met: true, confidence: -0.5 }),
        validationCommand: 'npm test',
        runValidation: validationOf(0),
      });
      // low conf → validation path → consensus
      expect(r.evaluator).toBe('consensus');
    });

    it('handles malformed Haiku response', () => {
      const r = evaluateHybrid('tests pass', {}, {
        runHaikuJudge: () => null,
        validationCommand: 'npm test',
        runValidation: validationOf(0),
      });
      // Haiku normalized to met=false,conf=0 → validation runs → conflict
      expect(r.met).toBe(true);
    });

    it('handles malformed validation response', () => {
      const r = evaluateHybrid('tests pass', {}, {
        validationCommand: 'npm test',
        runValidation: () => null,
      });
      expect(r.met).toBe(false);
    });
  });

  describe('low-confidence Haiku, no validation', () => {
    it('returns Haiku result with warning reasoning', () => {
      const r = evaluateHybrid('tests pass', {}, {
        runHaikuJudge: haikuOf(true, 0.5),
      });
      expect(r.evaluator).toBe('haiku');
      expect(r.reasoning).toMatch(/low-confidence/);
    });
  });
});
