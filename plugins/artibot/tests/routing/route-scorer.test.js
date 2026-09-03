/**
 * Tests for lib/routing/route-scorer.js (T-27).
 *
 * @module tests/routing/route-scorer
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  allCatalogTiers,
  BASELINE_LATENCY_MS,
  DEFAULT_CATALOG,
  DEFAULT_WEIGHTS,
  scoreRoutes,
  taskFitFor,
  TERM_NAMES,
  TIER_LATENCY_INDEX,
  TIER_QUALITY,
} from '../../lib/routing/route-scorer.js';
import { ACTION_CLASS_TIERS, ACTION_CLASSES } from '../../lib/routing/action-classifier.js';
import { getCostFactor, MODELS } from '../../lib/core/model-catalog.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(HERE, '../..');
const ALL_TIERS = ['haiku', 'sonnet', 'opus', 'fable'];

/** The receipt schema's required predicted keys, read from the schema itself. */
function schemaPredictedKeys() {
  const raw = readFileSync(resolve(PLUGIN_ROOT, 'schemas/route-receipt.schema.json'), 'utf8');
  return JSON.parse(raw).properties.predicted.required;
}

// ---------------------------------------------------------------------------
// Output shape
// ---------------------------------------------------------------------------

describe('scoreRoutes output shape', () => {
  it('returns one row per allowed tier', () => {
    const rows = scoreRoutes({ actionClass: 'implement', allowedTiers: ALL_TIERS });
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.tier).sort()).toEqual([...ALL_TIERS].sort());
  });

  it('carries all eight RouteUtility terms', () => {
    const [row] = scoreRoutes({ actionClass: 'implement', allowedTiers: ['opus'] });
    expect(Object.keys(row.terms).sort()).toEqual([...TERM_NAMES].sort());
    expect(TERM_NAMES).toHaveLength(8);
  });

  it('gives every term a value and a measured flag', () => {
    const [row] = scoreRoutes({ actionClass: 'review', allowedTiers: ['fable'] });
    for (const name of TERM_NAMES) {
      expect(Object.keys(row.terms[name]).sort()).toEqual(['measured', 'value']);
      expect(typeof row.terms[name].value).toBe('number');
      expect(typeof row.terms[name].measured).toBe('boolean');
    }
  });

  it('carries the four predicted keys the receipt schema requires', () => {
    const [row] = scoreRoutes({ actionClass: 'implement', allowedTiers: ['opus'] });
    expect(Object.keys(row.predicted).sort()).toEqual([...schemaPredictedKeys()].sort());
  });

  it('keeps predicted values inside the schema bounds', () => {
    const rows = scoreRoutes({
      actionClass: 'implement',
      allowedTiers: ALL_TIERS,
      signals: { contextTokens: 120_000, retriesSoFar: 2 },
    });
    for (const { predicted } of rows) {
      expect(predicted.success).toBeGreaterThanOrEqual(0);
      expect(predicted.success).toBeLessThanOrEqual(1);
      expect(predicted.retry_probability).toBeGreaterThanOrEqual(0);
      expect(predicted.retry_probability).toBeLessThanOrEqual(1);
      expect(predicted.cost).toBeGreaterThanOrEqual(0);
      expect(predicted.latency).toBeGreaterThanOrEqual(0);
    }
  });

  it('keeps utility inside 0..1', () => {
    for (const actionClass of ACTION_CLASSES) {
      for (const { utility } of scoreRoutes({ actionClass, allowedTiers: ALL_TIERS })) {
        expect(utility).toBeGreaterThanOrEqual(0);
        expect(utility).toBeLessThanOrEqual(1);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Fail-closed on a bad action class — the complex-debugging trap
// ---------------------------------------------------------------------------

describe('scoreRoutes rejects anything outside the eight classes', () => {
  it('returns an empty ranking for the advisor spelling complex-debugging', () => {
    expect(scoreRoutes({ actionClass: 'complex-debugging', allowedTiers: ALL_TIERS })).toEqual([]);
  });

  it('scores the real class complex-debug', () => {
    expect(scoreRoutes({ actionClass: 'complex-debug', allowedTiers: ALL_TIERS })).toHaveLength(4);
  });

  it.each([null, undefined, '', 'plan', 'debug', 7, {}])(
    'returns an empty ranking for actionClass %p',
    (bad) => {
      expect(scoreRoutes({ actionClass: bad, allowedTiers: ALL_TIERS })).toEqual([]);
    },
  );
});

// ---------------------------------------------------------------------------
// The allow-set is a hard boundary
// ---------------------------------------------------------------------------

describe('allowedTiers is never exceeded', () => {
  it('scores only tiers in the allow-set, even when another fits better', () => {
    const rows = scoreRoutes({ actionClass: 'architecture', allowedTiers: ['haiku'] });
    expect(rows.map((r) => r.tier)).toEqual(['haiku']);
  });

  it('accepts a Set as well as an array', () => {
    const rows = scoreRoutes({ actionClass: 'status', allowedTiers: new Set(['haiku', 'opus']) });
    expect(rows.map((r) => r.tier).sort()).toEqual(['haiku', 'opus']);
  });

  it('drops tiers the catalog does not know', () => {
    const rows = scoreRoutes({ actionClass: 'status', allowedTiers: ['haiku', 'gpt-5', 'llama'] });
    expect(rows.map((r) => r.tier)).toEqual(['haiku']);
  });

  it.each([[], new Set(), null, undefined, 'opus', 42])(
    'returns an empty ranking for allowedTiers %p',
    (bad) => {
      expect(scoreRoutes({ actionClass: 'implement', allowedTiers: bad })).toEqual([]);
    },
  );
});

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

describe('ranking', () => {
  it('is sorted by descending utility', () => {
    const rows = scoreRoutes({ actionClass: 'implement', allowedTiers: ALL_TIERS });
    const utilities = rows.map((r) => r.utility);
    expect([...utilities].sort((a, b) => b - a)).toEqual(utilities);
  });

  it('is deterministic across repeated calls', () => {
    const input = {
      actionClass: 'explore',
      allowedTiers: ALL_TIERS,
      signals: { contextTokens: 50_000, cacheReadTokens: 20_000, retriesSoFar: 1 },
    };
    const a = scoreRoutes(input).map((r) => `${r.tier}:${r.utility}`);
    const b = scoreRoutes(input).map((r) => `${r.tier}:${r.utility}`);
    expect(a).toEqual(b);
  });

  it.each([...ACTION_CLASSES])(
    'ranks the preferred tier of %s first when every tier is allowed',
    (actionClass) => {
      const rows = scoreRoutes({ actionClass, allowedTiers: ALL_TIERS });
      expect(rows[0].tier).toBe(ACTION_CLASS_TIERS[actionClass]);
    },
  );
});

// ---------------------------------------------------------------------------
// taskFit
// ---------------------------------------------------------------------------

describe('taskFitFor', () => {
  it.each([...ACTION_CLASSES])('is 1 at the preferred tier of %s', (actionClass) => {
    expect(taskFitFor(actionClass, ACTION_CLASS_TIERS[actionClass])).toBe(1);
  });

  it('penalises an under-capable tier harder than an over-capable one', () => {
    // architecture prefers fable: haiku is 3 steps below, so 1 - 3*(1/3) = 0
    expect(taskFitFor('architecture', 'haiku')).toBeCloseTo(0, 10);
    // classify prefers haiku: fable is 3 steps above, so 1 - 3*0.10 = 0.70
    expect(taskFitFor('classify', 'fable')).toBeCloseTo(0.70, 10);
    expect(taskFitFor('classify', 'fable')).toBeGreaterThan(taskFitFor('architecture', 'haiku'));
  });

  it('zeroes fit at the far end of the tier order rather than merely discounting it', () => {
    expect(taskFitFor('architecture', 'haiku')).toBe(0);
    expect(taskFitFor('review', 'haiku')).toBe(0);
    expect(taskFitFor('classify', 'fable')).toBeGreaterThan(0);
  });

  it('stays inside 0..1 for every class and tier pair', () => {
    for (const actionClass of ACTION_CLASSES) {
      for (const tier of ALL_TIERS) {
        const fit = taskFitFor(actionClass, tier);
        expect(fit).toBeGreaterThanOrEqual(0);
        expect(fit).toBeLessThanOrEqual(1);
      }
    }
  });

  it('returns the neutral value for an unknown class or tier', () => {
    expect(taskFitFor('nonsense', 'opus')).toBe(0.5);
    expect(taskFitFor('implement', 'nonsense')).toBe(0.5);
  });
});

// ---------------------------------------------------------------------------
// measured flags — the honesty contract
// ---------------------------------------------------------------------------

describe('measured flags', () => {
  it('marks the four constant terms unmeasured', () => {
    const [row] = scoreRoutes({ actionClass: 'implement', allowedTiers: ['opus'] });
    expect(row.terms.quality.measured).toBe(false);
    expect(row.terms.taskFit.measured).toBe(false);
    expect(row.terms.success.measured).toBe(false);
    expect(row.terms.latency.measured).toBe(false);
  });

  it('marks cost unmeasured even though it is computed, because prices are unverified', () => {
    const [row] = scoreRoutes({ actionClass: 'implement', allowedTiers: ALL_TIERS });
    expect(row.terms.cost.measured).toBe(false);
  });

  it('marks reliability unmeasured until provider health is supplied', () => {
    const bare = scoreRoutes({ actionClass: 'implement', allowedTiers: ['opus'] })[0];
    expect(bare.terms.reliability.measured).toBe(false);

    const withHealth = scoreRoutes({
      actionClass: 'implement',
      allowedTiers: ['opus'],
      signals: { providerHealth: { opus: 0.5 } },
    })[0];
    expect(withHealth.terms.reliability.measured).toBe(true);
    expect(withHealth.terms.reliability.value).toBeLessThan(bare.terms.reliability.value);
  });

  it('marks ctxAffinity measured only when contextTokens is supplied', () => {
    const bare = scoreRoutes({ actionClass: 'implement', allowedTiers: ['opus'] })[0];
    expect(bare.terms.ctxAffinity).toEqual({ value: 0.5, measured: false });

    const withCtx = scoreRoutes({
      actionClass: 'implement',
      allowedTiers: ['opus'],
      signals: { contextTokens: 500_000 },
    })[0];
    expect(withCtx.terms.ctxAffinity.measured).toBe(true);
    expect(withCtx.terms.ctxAffinity.value).toBeCloseTo(0.5, 10);
  });

  it('marks cacheAffinity measured only when both cache and context tokens are supplied', () => {
    const bare = scoreRoutes({
      actionClass: 'implement',
      allowedTiers: ['opus'],
      signals: { contextTokens: 100_000 },
    })[0];
    expect(bare.terms.cacheAffinity).toEqual({ value: 0.5, measured: false });

    const withCache = scoreRoutes({
      actionClass: 'implement',
      allowedTiers: ['opus'],
      signals: { contextTokens: 100_000, cacheReadTokens: 80_000 },
    })[0];
    expect(withCache.terms.cacheAffinity).toEqual({ value: 0.8, measured: true });
  });

  it('gives every candidate the same cacheAffinity, since the incumbent tier is unknown here', () => {
    const rows = scoreRoutes({
      actionClass: 'implement',
      allowedTiers: ALL_TIERS,
      signals: { contextTokens: 100_000, cacheReadTokens: 40_000 },
    });
    const values = new Set(rows.map((r) => r.terms.cacheAffinity.value));
    expect(values.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

describe('signals', () => {
  it('drops ctxAffinity to 0 when context exceeds the tier window', () => {
    const [row] = scoreRoutes({
      actionClass: 'status',
      allowedTiers: ['haiku'],
      signals: { contextTokens: MODELS.haiku.ctxLimit + 1 },
    });
    expect(row.terms.ctxAffinity.value).toBe(0);
  });

  it('lowers predicted success and raises retry probability with each retry', () => {
    const zero = scoreRoutes({
      actionClass: 'implement',
      allowedTiers: ['opus'],
      signals: { retriesSoFar: 0 },
    })[0].predicted;
    const two = scoreRoutes({
      actionClass: 'implement',
      allowedTiers: ['opus'],
      signals: { retriesSoFar: 2 },
    })[0].predicted;
    expect(two.success).toBeLessThan(zero.success);
    expect(two.retry_probability).toBeGreaterThan(zero.retry_probability);
    expect(two.success + two.retry_probability).toBeCloseTo(1, 10);
  });

  it('ignores negative or non-finite signal values instead of trusting them', () => {
    const rows = scoreRoutes({
      actionClass: 'implement',
      allowedTiers: ['opus'],
      signals: { contextTokens: -5, cacheReadTokens: NaN, retriesSoFar: -3 },
    });
    expect(rows[0].terms.ctxAffinity.measured).toBe(false);
    expect(rows[0].predicted.cost).toBe(0);
  });

  it('predicts cost from the input side only, scaled by the tokenizer coefficient', () => {
    const [row] = scoreRoutes({
      actionClass: 'review',
      allowedTiers: ['fable'],
      signals: { contextTokens: 1_000_000 },
    });
    // 1M tokens * 1.3 coeff / 1M * $10 per MTok
    expect(row.predicted.cost).toBeCloseTo(13, 10);
  });

  it('predicts cost 0 when contextTokens is absent, meaning unknown not free', () => {
    const [row] = scoreRoutes({ actionClass: 'review', allowedTiers: ['fable'] });
    expect(row.predicted.cost).toBe(0);
  });

  it('derives predicted latency from the tier index and the baseline', () => {
    const [row] = scoreRoutes({ actionClass: 'implement', allowedTiers: ['opus'] });
    expect(row.predicted.latency).toBe(TIER_LATENCY_INDEX.opus * BASELINE_LATENCY_MS);
  });
});

// ---------------------------------------------------------------------------
// Relative cost and latency efficiency
// ---------------------------------------------------------------------------

describe('cost and latency are relative to the candidate set', () => {
  it('gives the cheapest allowed tier a cost efficiency of 1', () => {
    const rows = scoreRoutes({ actionClass: 'implement', allowedTiers: ALL_TIERS });
    const byTier = Object.fromEntries(rows.map((r) => [r.tier, r]));
    expect(byTier.haiku.terms.cost.value).toBe(1);
    expect(byTier.fable.terms.cost.value)
      .toBeCloseTo(getCostFactor('haiku') / getCostFactor('fable'), 10);
  });

  it('re-bases cost efficiency when the allow-set narrows', () => {
    const narrow = scoreRoutes({ actionClass: 'implement', allowedTiers: ['opus', 'fable'] });
    expect(narrow.find((r) => r.tier === 'opus').terms.cost.value).toBe(1);
  });

  it('gives a single-tier allow-set a cost and latency efficiency of 1', () => {
    const [row] = scoreRoutes({ actionClass: 'review', allowedTiers: ['fable'] });
    expect(row.terms.cost.value).toBe(1);
    expect(row.terms.latency.value).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Weights
// ---------------------------------------------------------------------------

describe('weights', () => {
  it('defaults sum to 1', () => {
    const total = TERM_NAMES.reduce((s, n) => s + DEFAULT_WEIGHTS[n], 0);
    expect(total).toBeCloseTo(1, 10);
  });

  it('covers exactly the eight term names', () => {
    expect(Object.keys(DEFAULT_WEIGHTS).sort()).toEqual([...TERM_NAMES].sort());
  });

  it('zeroing the cost weight can change the winner (the §4.3 maximum profile)', () => {
    const input = { actionClass: 'status', allowedTiers: ['haiku', 'fable'] };
    const balanced = scoreRoutes(input)[0].tier;
    const maximum = scoreRoutes(input, {
      weights: { ...DEFAULT_WEIGHTS, cost: 0, latency: 0, quality: 0.35, success: 0.30 },
    })[0].tier;
    expect(balanced).toBe('haiku');
    expect(maximum).toBe('fable');
  });

  it('renormalises an override so utility stays inside 0..1', () => {
    const rows = scoreRoutes(
      { actionClass: 'implement', allowedTiers: ALL_TIERS },
      { weights: { quality: 10, taskFit: 10, success: 10, reliability: 10, ctxAffinity: 10, cacheAffinity: 10, cost: 10, latency: 10 } },
    );
    for (const { utility } of rows) {
      expect(utility).toBeLessThanOrEqual(1);
    }
  });

  it('falls back to the defaults when every weight is zeroed', () => {
    const zeroed = Object.fromEntries(TERM_NAMES.map((n) => [n, 0]));
    const a = scoreRoutes({ actionClass: 'implement', allowedTiers: ALL_TIERS });
    const b = scoreRoutes({ actionClass: 'implement', allowedTiers: ALL_TIERS }, { weights: zeroed });
    expect(b.map((r) => r.utility)).toEqual(a.map((r) => r.utility));
  });

  it('ignores unknown and invalid weight keys', () => {
    const a = scoreRoutes({ actionClass: 'implement', allowedTiers: ALL_TIERS });
    const b = scoreRoutes(
      { actionClass: 'implement', allowedTiers: ALL_TIERS },
      { weights: { nonsense: 5, quality: 'x' } },
    );
    expect(b.map((r) => r.utility)).toEqual(a.map((r) => r.utility));
  });
});

// ---------------------------------------------------------------------------
// Injected catalog
// ---------------------------------------------------------------------------

describe('catalog injection', () => {
  it('defaults to the real model catalog', () => {
    expect(DEFAULT_CATALOG.getModel('fable').id).toBe('claude-fable-5-1');
    expect(typeof DEFAULT_CATALOG.version).toBe('string');
  });

  it('uses an injected price table instead of the live one', () => {
    const pinned = {
      getModel: (tier) => (tier === 'opus'
        ? { id: 'pinned-opus', priceInPerMTok: 1, priceOutPerMTok: 5, tokenizerCoeff: 1, ctxLimit: 1000 }
        : null),
      getCostFactor: () => 1,
    };
    const rows = scoreRoutes({
      actionClass: 'implement',
      allowedTiers: ['opus', 'fable'],
      catalog: pinned,
      signals: { contextTokens: 1_000_000 },
    });
    expect(rows.map((r) => r.tier)).toEqual(['opus']);
    expect(rows[0].predicted.cost).toBeCloseTo(1, 10);
  });

  it('tolerates a catalog port without getCostFactor', () => {
    const minimal = { getModel: (t) => (t === 'opus' ? MODELS.opus : null) };
    const rows = scoreRoutes({ actionClass: 'implement', allowedTiers: ['opus'], catalog: minimal });
    expect(rows).toHaveLength(1);
    expect(rows[0].terms.cost.value).toBe(1);
  });

  it('ignores a malformed catalog and falls back to the default', () => {
    for (const bad of [null, {}, 'catalog', 7]) {
      const rows = scoreRoutes({ actionClass: 'implement', allowedTiers: ['opus'], catalog: bad });
      expect(rows).toHaveLength(1);
    }
  });
});

// ---------------------------------------------------------------------------
// Static tables
// ---------------------------------------------------------------------------

describe('static tables', () => {
  it('cover every catalog tier', () => {
    expect(Object.keys(TIER_QUALITY).sort()).toEqual([...ALL_TIERS].sort());
    expect(Object.keys(TIER_LATENCY_INDEX).sort()).toEqual([...ALL_TIERS].sort());
    expect(allCatalogTiers().sort()).toEqual([...ALL_TIERS].sort());
  });

  it('are frozen', () => {
    expect(Object.isFrozen(TIER_QUALITY)).toBe(true);
    expect(Object.isFrozen(TIER_LATENCY_INDEX)).toBe(true);
    expect(Object.isFrozen(DEFAULT_WEIGHTS)).toBe(true);
    expect(Object.isFrozen(DEFAULT_CATALOG)).toBe(true);
  });

  it('order quality and latency monotonically by tier', () => {
    const quality = ALL_TIERS.map((t) => TIER_QUALITY[t]);
    const latency = ALL_TIERS.map((t) => TIER_LATENCY_INDEX[t]);
    expect([...quality].sort((a, b) => a - b)).toEqual(quality);
    expect([...latency].sort((a, b) => a - b)).toEqual(latency);
  });

  it('never throws on garbage input', () => {
    for (const bad of [undefined, null, 'x', 7, []]) {
      expect(() => scoreRoutes(bad)).not.toThrow();
      expect(scoreRoutes(bad)).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// Layer rule: lib/routing (L2) may import lib/core (L1) only
// ---------------------------------------------------------------------------

describe('layer discipline', () => {
  it('imports only lib/core and its own directory', () => {
    const src = readFileSync(resolve(PLUGIN_ROOT, 'lib/routing/route-scorer.js'), 'utf8');
    const imports = [...src.matchAll(/^\s*import\s[^;]*?from\s+'([^']+)'/gm)].map((m) => m[1]);
    expect(imports.sort()).toEqual(['../core/model-catalog.js', './action-classifier.js']);
    for (const higher of ['cognitive', 'topology', 'learning', 'handoff', 'runtime']) {
      expect(imports.some((i) => i.includes(`/${higher}/`))).toBe(false);
    }
  });
});
