/**
 * Tests for differential-privacy.js — Laplacian noise for federated learning.
 *
 * @module tests/privacy/differential-privacy
 */

import { describe, expect, it } from 'vitest';
import {
  addNoiseToValue,
  computeScale,
  createNoiseFunction,
  EXCLUDED_FIELDS,
  laplaceSample,
  secureRandom,
  validateDPConfig,
} from '../../lib/privacy/differential-privacy.js';

describe('differential-privacy', () => {
  describe('secureRandom', () => {
    it('should return a number in [0, 1)', () => {
      for (let i = 0; i < 100; i++) {
        const r = secureRandom();
        expect(r).toBeGreaterThanOrEqual(0);
        expect(r).toBeLessThan(1);
      }
    });
  });

  describe('computeScale', () => {
    it('should compute sensitivity / epsilon', () => {
      expect(computeScale(1.0)).toBe(1.0);
      expect(computeScale(2.0)).toBe(0.5);
      expect(computeScale(0.5)).toBe(2.0);
    });

    it('should support custom sensitivity', () => {
      expect(computeScale(1.0, 2.0)).toBe(2.0);
    });

    it('should throw for non-positive epsilon', () => {
      expect(() => computeScale(0)).toThrow('Epsilon must be positive');
      expect(() => computeScale(-1)).toThrow('Epsilon must be positive');
    });
  });

  describe('laplaceSample', () => {
    it('should generate samples centered around 0', () => {
      const samples = Array.from({ length: 10000 }, () => laplaceSample(1.0));
      const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
      expect(Math.abs(mean)).toBeLessThan(0.1); // Mean should be near 0
    });

    it('should respect scale parameter', () => {
      const smallScale = Array.from({ length: 1000 }, () => laplaceSample(0.1));
      const largeScale = Array.from({ length: 1000 }, () => laplaceSample(10.0));

      const smallStd = Math.sqrt(
        smallScale.reduce((s, x) => s + x * x, 0) / smallScale.length,
      );
      const largeStd = Math.sqrt(
        largeScale.reduce((s, x) => s + x * x, 0) / largeScale.length,
      );

      // Larger scale → larger spread
      expect(largeStd).toBeGreaterThan(smallStd);
    });
  });

  describe('addNoiseToValue', () => {
    it('should clamp result to [0, 1]', () => {
      for (let i = 0; i < 200; i++) {
        const result = addNoiseToValue(0.5, 0.5);
        expect(result).toBeGreaterThanOrEqual(0);
        expect(result).toBeLessThanOrEqual(1);
      }
    });

    it('should clamp from 0 boundary', () => {
      for (let i = 0; i < 100; i++) {
        const result = addNoiseToValue(0, 0.1);
        expect(result).toBeGreaterThanOrEqual(0);
      }
    });

    it('should clamp from 1 boundary', () => {
      for (let i = 0; i < 100; i++) {
        const result = addNoiseToValue(1, 0.1);
        expect(result).toBeLessThanOrEqual(1);
      }
    });
  });

  describe('createNoiseFunction', () => {
    it('should return identity function when disabled', () => {
      const fn = createNoiseFunction({ enabled: false });
      const weights = { tools: { t1: { score: 0.5 } } };
      expect(fn(weights)).toBe(weights); // Same reference
    });

    it('should apply noise to numeric fields', () => {
      const fn = createNoiseFunction({ epsilon: 1.0 });
      const weights = {
        tools: { t1: { score: 0.5, confidence: 0.8 } },
      };

      const noised = fn(weights);
      // Values should be different (noise applied)
      // but still in [0, 1]
      expect(noised.tools.t1.score).toBeGreaterThanOrEqual(0);
      expect(noised.tools.t1.score).toBeLessThanOrEqual(1);
      expect(noised.tools.t1.confidence).toBeGreaterThanOrEqual(0);
      expect(noised.tools.t1.confidence).toBeLessThanOrEqual(1);
    });

    it('should preserve non-numeric fields', () => {
      const fn = createNoiseFunction({ epsilon: 1.0 });
      const weights = {
        tools: { t1: { name: 'test-tool', active: true } },
      };

      const noised = fn(weights);
      expect(noised.tools.t1.name).toBe('test-tool');
      expect(noised.tools.t1.active).toBe(true);
    });

    it('should exclude sampleSize from noise', () => {
      const fn = createNoiseFunction({ epsilon: 0.1 }); // high noise
      const weights = {
        tools: { t1: { score: 0.5, sampleSize: 42 } },
      };

      const noised = fn(weights);
      expect(noised.tools.t1.sampleSize).toBe(42); // unchanged
    });

    it('should exclude metadata fields from noise', () => {
      const fn = createNoiseFunction({ epsilon: 0.5 });
      const weights = {
        tools: { t1: { score: 0.5, version: 1, checksum: 'abc', storedAt: '2024-01-01' } },
      };

      const noised = fn(weights);
      expect(noised.tools.t1.version).toBe(1);
      expect(noised.tools.t1.checksum).toBe('abc');
      expect(noised.tools.t1.storedAt).toBe('2024-01-01');
    });

    it('should handle null/undefined input', () => {
      const fn = createNoiseFunction({ epsilon: 1.0 });
      expect(fn(null)).toBeNull();
      expect(fn(undefined)).toBeUndefined();
    });

    it('should handle empty weights', () => {
      const fn = createNoiseFunction({ epsilon: 1.0 });
      expect(fn({})).toEqual({});
    });

    it('should produce different values each call (non-deterministic)', () => {
      const fn = createNoiseFunction({ epsilon: 1.0 });
      const weights = { tools: { t1: { score: 0.5 } } };

      const results = new Set();
      for (let i = 0; i < 10; i++) {
        results.add(fn(weights).tools.t1.score);
      }
      // At least 2 different values (virtually guaranteed with noise)
      expect(results.size).toBeGreaterThan(1);
    });

    it('should handle nested object structures', () => {
      const fn = createNoiseFunction({ epsilon: 1.0 });
      const weights = {
        tools: {
          t1: { score: 0.5 },
          t2: { score: 0.8, nested: { value: 0.3 } },
        },
        errors: {
          e1: { rate: 0.1 },
        },
      };

      const noised = fn(weights);
      expect(noised.tools.t1).toBeDefined();
      expect(noised.tools.t2.nested.value).toBeGreaterThanOrEqual(0);
      expect(noised.errors.e1.rate).toBeGreaterThanOrEqual(0);
    });

    it('should handle array values', () => {
      const fn = createNoiseFunction({ epsilon: 1.0 });
      const weights = {
        tools: { t1: { scores: [0.5, 0.7, 0.9] } },
      };

      const noised = fn(weights);
      expect(Array.isArray(noised.tools.t1.scores)).toBe(true);
      expect(noised.tools.t1.scores).toHaveLength(3);
      noised.tools.t1.scores.forEach((s) => {
        expect(s).toBeGreaterThanOrEqual(0);
        expect(s).toBeLessThanOrEqual(1);
      });
    });

    it('should use default epsilon when not specified', () => {
      const fn = createNoiseFunction();
      const weights = { tools: { t1: { score: 0.5 } } };
      const noised = fn(weights);
      expect(noised.tools.t1.score).toBeGreaterThanOrEqual(0);
      expect(noised.tools.t1.score).toBeLessThanOrEqual(1);
    });
  });

  describe('EXCLUDED_FIELDS', () => {
    it('should contain expected exclusions', () => {
      expect(EXCLUDED_FIELDS.has('sampleSize')).toBe(true);
      expect(EXCLUDED_FIELDS.has('storedAt')).toBe(true);
      expect(EXCLUDED_FIELDS.has('version')).toBe(true);
      expect(EXCLUDED_FIELDS.has('checksum')).toBe(true);
    });

    it('should not contain learnable fields', () => {
      expect(EXCLUDED_FIELDS.has('score')).toBe(false);
      expect(EXCLUDED_FIELDS.has('confidence')).toBe(false);
    });
  });

  describe('validateDPConfig', () => {
    it('should accept valid config', () => {
      const result = validateDPConfig({ epsilon: 1.0, delta: 1e-5, enabled: true });
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should reject non-positive epsilon', () => {
      const result = validateDPConfig({ epsilon: 0 });
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('epsilon');
    });

    it('should reject negative epsilon', () => {
      const result = validateDPConfig({ epsilon: -1 });
      expect(result.valid).toBe(false);
    });

    it('should reject non-numeric epsilon', () => {
      const result = validateDPConfig({ epsilon: 'high' });
      expect(result.valid).toBe(false);
    });

    it('should reject delta >= 1', () => {
      const result = validateDPConfig({ delta: 1 });
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('delta');
    });

    it('should reject negative delta', () => {
      const result = validateDPConfig({ delta: -0.1 });
      expect(result.valid).toBe(false);
    });

    it('should reject non-boolean enabled', () => {
      const result = validateDPConfig({ enabled: 'yes' });
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('enabled');
    });

    it('should accept empty config (all optional)', () => {
      const result = validateDPConfig({});
      expect(result.valid).toBe(true);
    });

    it('should accept delta of 0', () => {
      const result = validateDPConfig({ delta: 0 });
      expect(result.valid).toBe(true);
    });
  });
});
