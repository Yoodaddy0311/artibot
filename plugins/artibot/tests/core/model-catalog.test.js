import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  BASELINE_TIER,
  getCostFactor,
  getModel,
  getPricing,
  getTokenizerCoeff,
  listTiers,
  MODELS,
  PRICING_VERSION,
  resolveRole,
  ROLE_ALIASES,
} from '../../lib/core/model-catalog.js';

// Harness model enum whitelist — the tiers Claude Code Agent/Task `model` accepts.
const ENUM_WHITELIST = ['sonnet', 'opus', 'haiku', 'fable'];

/**
 * Official per-MTok price table (platform.claude.com pricing page, verified
 * 2026-09-12). Literal pins: these numbers are copied from the page, NOT
 * derived from each other, so a future "simplification" that computes cache
 * prices from a single multiplier breaks here instead of silently mispricing
 * fable (whose cache multiplier is 0.025x, not the usual 0.1x).
 */
const PRICE_TABLE = [
  { tier: 'haiku', id: 'claude-haiku-4-5', input: 1, output: 5, cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2 },
  { tier: 'sonnet', id: 'claude-sonnet-4-6', input: 3, output: 15, cacheRead: 0.3, cacheWrite5m: 3.75, cacheWrite1h: 6 },
  { tier: 'opus', id: 'claude-opus-5', input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 },
  { tier: 'fable', id: 'claude-fable-5-1', input: 10, output: 50, cacheRead: 0.25, cacheWrite5m: 12.5, cacheWrite1h: 20 },
];

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

  describe('price table (verified against PRICING_SOURCE 2026-09-12)', () => {
    it.each(PRICE_TABLE)(
      '$tier pins all five price columns',
      ({ tier, id, input, output, cacheRead, cacheWrite5m, cacheWrite1h }) => {
        const m = getModel(tier);
        expect(m.id).toBe(id);
        expect(m.priceInPerMTok).toBe(input);
        expect(m.priceOutPerMTok).toBe(output);
        expect(m.priceCacheReadPerMTok).toBe(cacheRead);
        expect(m.priceCacheWrite5mPerMTok).toBe(cacheWrite5m);
        expect(m.priceCacheWrite1hPerMTok).toBe(cacheWrite1h);
      },
    );

    it('fable cache reads are 0.025x input, NOT the usual 0.1x', () => {
      // Official footnote: "Cache hits and refreshes on Claude Fable 5.1 are
      // priced at 0.025x the base input price. All other models use the
      // standard 0.1x multiplier." A well-meaning "fix" to 10% would make
      // fable cache reads 4x too expensive — this pin catches it.
      const fable = getModel('fable');
      expect(fable.priceCacheReadPerMTok).toBeCloseTo(
        0.025 * fable.priceInPerMTok,
        10,
      );
      expect(fable.priceCacheReadPerMTok).not.toBeCloseTo(
        0.1 * fable.priceInPerMTok,
        10,
      );
    });

    it.each(['haiku', 'sonnet', 'opus'])(
      '%s cache reads are the standard 0.1x of input',
      (tier) => {
        const m = getModel(tier);
        expect(m.priceCacheReadPerMTok).toBeCloseTo(0.1 * m.priceInPerMTok, 10);
      },
    );

    it.each(PRICE_TABLE)(
      '$tier cache writes are 1.25x (5m) and 2x (1h) of input',
      ({ tier }) => {
        const m = getModel(tier);
        expect(m.priceCacheWrite5mPerMTok).toBeCloseTo(
          1.25 * m.priceInPerMTok,
          10,
        );
        expect(m.priceCacheWrite1hPerMTok).toBeCloseTo(
          2 * m.priceInPerMTok,
          10,
        );
      },
    );

    it.each(PRICE_TABLE)('$tier is priceMeasured: true', ({ tier }) => {
      expect(getModel(tier).priceMeasured).toBe(true);
    });

    it.each(PRICE_TABLE)(
      '$tier is tokenizerCoeffMeasured: false (coefficients are estimates)',
      ({ tier }) => {
        // Not a defect to fix here: the official page says Claude 4.7+ share a
        // newer tokenizer, so fable and the opus baseline plausibly tokenize
        // alike and the shipped fable 1.3 is unverified. Flag only — changing
        // it (and getCostFactor's 2.6) is an owner decision.
        expect(getModel(tier).tokenizerCoeffMeasured).toBe(false);
      },
    );
  });

  describe('getPricing()', () => {
    it('returns the full pricing shape for a tier', () => {
      expect(getPricing('opus')).toEqual({
        tier: 'opus',
        id: 'claude-opus-5',
        input: 5,
        output: 25,
        cacheRead: 0.5,
        cacheWrite5m: 6.25,
        cacheWrite1h: 10,
        measured: true,
        version: PRICING_VERSION,
      });
    });

    it('resolves role aliases (frontier → opus, deep-async → fable)', () => {
      expect(getPricing('frontier').tier).toBe('opus');
      expect(getPricing('frontier').id).toBe('claude-opus-5');
      expect(getPricing('deep-async').tier).toBe('fable');
    });

    it('stamps version and measured on every tier', () => {
      for (const tier of listTiers()) {
        const p = getPricing(tier);
        expect(p.version).toBe(PRICING_VERSION);
        expect(p.measured).toBe(true);
      }
    });

    it('returns a frozen object (callers cannot corrupt the price table)', () => {
      const p = getPricing('fable');
      expect(Object.isFrozen(p)).toBe(true);
      try {
        p.input = 999;
      } catch {
        /* strict-mode TypeError is also acceptable */
      }
      expect(p.input).toBe(10);
    });

    it('returns null for unknown tier and bad input (never throws)', () => {
      expect(getPricing('nope')).toBeNull();
      expect(getPricing('')).toBeNull();
      expect(getPricing(null)).toBeNull();
      expect(getPricing(undefined)).toBeNull();
      expect(getPricing(42)).toBeNull();
      expect(getPricing({})).toBeNull();
      expect(getPricing('toString')).toBeNull();
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
          'priceCacheReadPerMTok',
          'priceCacheWrite5mPerMTok',
          'priceCacheWrite1hPerMTok',
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

    it('(e) the source contains no URL literal (PRICING_SOURCE stays scheme-less)', () => {
      // Mirror of tests/ci/data-policy-outbound-guard.test.js so the reason is
      // visible next to the constant: that guard fails this file on ANY
      // http/https literal, comments included. PRICING_SOURCE is therefore
      // stored without a scheme on purpose.
      const urlLiterals = catalogSrc.match(/https?:\/\//g) ?? [];
      expect(urlLiterals).toEqual([]);
    });
  });
});
