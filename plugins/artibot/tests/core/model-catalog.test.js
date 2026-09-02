import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  BASELINE_TIER,
  getCostFactor,
  getModel,
  getTokenizerCoeff,
  listTiers,
  MODELS,
  resolveRole,
  ROLE_ALIASES,
} from '../../lib/core/model-catalog.js';

// Harness model enum whitelist — the tiers Claude Code Agent/Task `model` accepts.
const ENUM_WHITELIST = ['sonnet', 'opus', 'haiku', 'fable'];

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const catalogSrcPath = path.join(
  __dirname,
  '..',
  '..',
  'lib',
  'core',
  'model-catalog.js',
);
const catalogSrc = await readFile(catalogSrcPath, 'utf8');

describe('model-catalog', () => {
  describe('getModel()', () => {
    it('returns the full spec for a known tier', () => {
      expect(getModel('fable')).toMatchObject({
        id: 'claude-fable-5-1',
        priceInPerMTok: 10,
        priceOutPerMTok: 50,
        tokenizerCoeff: 1.3,
        ctxLimit: 1_000_000,
        outLimit: 128_000,
        thinkingMode: 'always-on',
        promptStyle: 'declarative',
      });
      expect(getModel('opus').id).toBe('claude-opus-5');
      expect(getModel('sonnet').id).toBe('claude-sonnet-4-6');
      expect(getModel('haiku').id).toBe('claude-haiku-4-5');
    });

    it('returns null for an unknown tier', () => {
      expect(getModel('mythos')).toBeNull();
    });

    it('returns null for non-string input (never throws)', () => {
      expect(getModel(null)).toBeNull();
      expect(getModel(undefined)).toBeNull();
      expect(getModel(42)).toBeNull();
      expect(getModel({})).toBeNull();
    });

    it('does not leak inherited Object props as tiers', () => {
      expect(getModel('toString')).toBeNull();
      expect(getModel('hasOwnProperty')).toBeNull();
    });
  });

  describe('resolveRole()', () => {
    it('maps role aliases to tiers', () => {
      expect(resolveRole('frontier')).toBe('opus');
      expect(resolveRole('deep-async')).toBe('fable');
      expect(resolveRole('balanced')).toBe('sonnet');
      expect(resolveRole('fast')).toBe('haiku');
    });

    it('passes through a raw tier unchanged', () => {
      expect(resolveRole('opus')).toBe('opus');
      expect(resolveRole('fable')).toBe('fable');
    });

    it('returns null for unknown role/tier and bad input (never throws)', () => {
      expect(resolveRole('nope')).toBeNull();
      expect(resolveRole('')).toBeNull();
      expect(resolveRole(null)).toBeNull();
      expect(resolveRole(undefined)).toBeNull();
      expect(resolveRole(7)).toBeNull();
    });
  });

  describe('listTiers()', () => {
    it('returns all catalog tiers', () => {
      expect(listTiers().sort()).toEqual([...ENUM_WHITELIST].sort());
    });

    it('returns a fresh array (mutation does not affect the source)', () => {
      const list = listTiers();
      list.push('mutant');
      expect(listTiers()).not.toContain('mutant');
    });
  });

  describe('getTokenizerCoeff()', () => {
    it('returns the per-tier coefficient', () => {
      expect(getTokenizerCoeff('fable')).toBe(1.3);
      expect(getTokenizerCoeff('opus')).toBe(1.0);
      expect(getTokenizerCoeff('sonnet')).toBe(1.0);
      expect(getTokenizerCoeff('haiku')).toBe(1.0);
    });

    it('returns 1.0 for unknown tier / bad input', () => {
      expect(getTokenizerCoeff('mythos')).toBe(1.0);
      expect(getTokenizerCoeff(null)).toBe(1.0);
      expect(getTokenizerCoeff(99)).toBe(1.0);
    });
  });

  describe('getCostFactor()', () => {
    it('baseline opus is 1.0', () => {
      expect(getCostFactor(BASELINE_TIER)).toBe(1);
    });

    it('fable = (10/5) * 1.3 = 2.6', () => {
      expect(getCostFactor('fable')).toBeCloseTo(2.6, 10);
    });

    it('sonnet = (3/5) * 1.0 = 0.6', () => {
      expect(getCostFactor('sonnet')).toBeCloseTo(0.6, 10);
    });

    it('returns 1.0 for unknown tier / bad input', () => {
      expect(getCostFactor('mythos')).toBe(1.0);
      expect(getCostFactor(null)).toBe(1.0);
    });
  });

  describe('immutability (deep-freeze)', () => {
    it('MODELS is frozen', () => {
      expect(Object.isFrozen(MODELS)).toBe(true);
    });

    it('nested model specs are frozen', () => {
      expect(Object.isFrozen(MODELS.fable)).toBe(true);
    });

    it('nested constraint arrays are frozen', () => {
      expect(Object.isFrozen(MODELS.fable.constraints)).toBe(true);
    });

    it('ROLE_ALIASES is frozen', () => {
      expect(Object.isFrozen(ROLE_ALIASES)).toBe(true);
    });

    it('mutation attempts are silently ignored (frozen)', () => {
      const before = MODELS.fable.priceInPerMTok;
      try {
        MODELS.fable.priceInPerMTok = 999;
      } catch {
        /* strict-mode TypeError is also acceptable */
      }
      expect(MODELS.fable.priceInPerMTok).toBe(before);
    });
  });

  describe('drift guards', () => {
    it('(a) listTiers() is a subset of the harness enum whitelist', () => {
      for (const tier of listTiers()) {
        expect(ENUM_WHITELIST).toContain(tier);
      }
    });

    it('(b) all prices and coefficients are finite and > 0', () => {
      for (const tier of listTiers()) {
        const m = getModel(tier);
        for (const field of [
          'priceInPerMTok',
          'priceOutPerMTok',
          'tokenizerCoeff',
          'ctxLimit',
          'outLimit',
        ]) {
          expect(Number.isFinite(m[field])).toBe(true);
          expect(m[field]).toBeGreaterThan(0);
        }
      }
    });

    it('(c) model-catalog.js imports no other lib module (one-way dependency)', () => {
      expect(catalogSrc).not.toMatch(/from\s+['"]\.\/model-policy/);
      // No relative import of any sibling/parent lib module at all.
      expect(catalogSrc).not.toMatch(/^\s*import\s.*from\s+['"]\.\.?\//m);
    });

    it('(d) fable tokenizerCoeff stays >= 1.2 (re-baseline reminder)', () => {
      expect(getTokenizerCoeff('fable')).toBeGreaterThanOrEqual(1.2);
    });
  });
});
