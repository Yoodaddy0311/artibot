import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getPricing, PRICING_VERSION } from '../../../lib/core/model-catalog.js';
import {
  _extractUsage,
  _PRICING,
  _resolveModel,
  _resolvePricing,
  _safeInt,
  computeCacheMetrics,
  createCacheRoiMiddleware,
  createEmptySession,
  foldMetrics,
  persistSession,
  resolveSessionPath,
  UNKNOWN_FALLBACK_TIER,
} from '../../../lib/runtime/middleware/cache-roi.js';

const CACHE_ROI_SRC_URL = new URL(
  '../../../lib/runtime/middleware/cache-roi.js',
  import.meta.url,
);

/** Strip block and line comments so a scan sees only executable source. */
function stripComments(src) {
  // `[^\r\n]*` rather than `.*$`: on a CRLF checkout each line still ends in
  // `\r`, which `.` does not match, so `$` never anchored and `//` comments
  // survived the strip (observed 2026-09-12 on Windows autocrlf).
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/[^\r\n]*/, ''))
    .join('\n');
}

// ---------------------------------------------------------------------------
// _safeInt
// ---------------------------------------------------------------------------

describe('_safeInt', () => {
  it('returns floored non-negative integers', () => {
    expect(_safeInt(10.7)).toBe(10);
    expect(_safeInt('42')).toBe(42);
  });

  it('clamps negatives and non-finite to 0', () => {
    expect(_safeInt(-5)).toBe(0);
    expect(_safeInt(NaN)).toBe(0);
    expect(_safeInt(Infinity)).toBe(0);
    expect(_safeInt(undefined)).toBe(0);
    expect(_safeInt(null)).toBe(0);
    expect(_safeInt('foo')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Single price table: the catalog
// ---------------------------------------------------------------------------

describe('cache-roi pricing source', () => {
  it('carries no PRICING_USD_PER_M identifier outside comments', () => {
    const raw = readFileSync(CACHE_ROI_SRC_URL, 'utf8');
    // Stripper self-verification (rules §10): the raw source DOES mention the
    // identifier once, in the comment explaining its removal. If this
    // precondition fails the scan below proves nothing; if the stripper
    // silently stopped stripping, the 0-hits assertion is what goes red.
    expect(raw.match(/PRICING_USD_PER_M/g) || []).toHaveLength(1);
    const code = stripComments(raw);
    const hits = code.match(/PRICING_USD_PER_M/g) || [];
    expect(hits).toHaveLength(0);
  });

  it('imports its prices from the model catalog', () => {
    const src = readFileSync(CACHE_ROI_SRC_URL, 'utf8');
    expect(src).toContain("from '../../core/model-catalog.js'");
  });

  it('falls back to the sonnet row for unrecognized models', () => {
    expect(UNKNOWN_FALLBACK_TIER).toBe('sonnet');
  });

  // Guards the one catalog invariant cache-roi.js relies on without a runtime
  // branch: the fallback tier must exist, or every price would be undefined.
  it('resolves the fallback tier in the catalog', () => {
    const p = getPricing(UNKNOWN_FALLBACK_TIER);
    expect(p).not.toBeNull();
    expect(p.tier).toBe('sonnet');
    expect(getPricing('no-such-tier')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// _resolvePricing
// ---------------------------------------------------------------------------

describe('_resolvePricing', () => {
  it('matches fable / opus / sonnet / haiku by substring', () => {
    expect(_resolvePricing('claude-fable-5')).toEqual(getPricing('fable'));
    // claude-opus-5 is the shipped `opus` tier ID (model-catalog.js#MODELS).
    expect(_resolvePricing('claude-opus-5')).toEqual(getPricing('opus'));
    expect(_resolvePricing('claude-sonnet-4-6')).toEqual(getPricing('sonnet'));
    expect(_resolvePricing('claude-haiku-4-5-20251001')).toEqual(getPricing('haiku'));
  });

  it('resolves older IDs the catalog does not list, e.g. claude-opus-4-8', () => {
    const p = _resolvePricing('claude-opus-4-8');
    expect(p.tier).toBe('opus');
    expect(p.input).toBe(getPricing('opus').input);
    expect(p.output).toBe(getPricing('opus').output);
    expect(_resolvePricing('claude-opus-4-7').tier).toBe('opus');
  });

  it('prices fable input at 2x opus and fable cache read at 0.5x opus (0.025x rule)', () => {
    const fable = getPricing('fable');
    const opus = getPricing('opus');
    expect(fable.input).toBe(opus.input * 2);
    expect(fable.output).toBe(opus.output * 2);
    // Official fable cache read is 0.025x input (0.25), not 10% (1.00), so it
    // lands BELOW opus cache read even though fable input is twice as costly.
    expect(fable.cacheRead).toBeCloseTo(opus.cacheRead * 0.5, 10);
    expect(fable.cacheRead).toBe(0.25);
  });

  it('falls back to the sonnet row for invalid / unrecognized models', () => {
    const sonnet = getPricing('sonnet');
    expect(_resolvePricing('')).toEqual(sonnet);
    expect(_resolvePricing(null)).toEqual(sonnet);
    expect(_resolvePricing(42)).toEqual(sonnet);
    expect(_resolvePricing('gpt-4')).toEqual(sonnet);
    expect(_resolvePricing('gpt-4').tier).toBe('sonnet');
  });

  it('is case-insensitive', () => {
    expect(_resolvePricing('CLAUDE-OPUS-X')).toEqual(getPricing('opus'));
  });

  it('exposes a derived _PRICING compat view keyed by tier plus unknown', () => {
    const sonnet = getPricing('sonnet');
    expect(_PRICING.sonnet).toEqual({
      input: sonnet.input,
      output: sonnet.output,
      cacheRead: sonnet.cacheRead,
      cacheWrite: sonnet.cacheWrite5m,
    });
    expect(_PRICING.unknown).toEqual(_PRICING.sonnet);
    expect(_PRICING.opus.input).toBe(5);
    expect(_PRICING.haiku.cacheWrite).toBe(1.25);
    expect(Object.isFrozen(_PRICING)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// computeCacheMetrics
// ---------------------------------------------------------------------------

describe('computeCacheMetrics', () => {
  const FIXED = 1_700_000_000_000;
  const nowFn = () => FIXED;
  const ONE_M_EACH = {
    cache_read_input_tokens: 1_000_000,
    cache_creation_input_tokens: 1_000_000,
    input_tokens: 1_000_000,
    output_tokens: 1_000_000,
  };

  it('produces zeros and 0 hitRate for empty usage', () => {
    const m = computeCacheMetrics({}, 'opus', nowFn);
    expect(m.cacheReadTokens).toBe(0);
    expect(m.hitRate).toBe(0);
    expect(m.savedCostUsd).toBe(0);
    expect(m.spentCostUsd).toBe(0);
    expect(m.timestamp).toBe(new Date(FIXED).toISOString());
  });

  it('computes hitRate from cache_read / (cache_read + cache_creation + input)', () => {
    const m = computeCacheMetrics(
      {
        cache_read_input_tokens: 80,
        cache_creation_input_tokens: 10,
        input_tokens: 10,
        output_tokens: 5,
      },
      'sonnet',
      nowFn,
    );
    expect(m.hitRate).toBeCloseTo(0.8, 5);
    expect(m.savedTokens).toBe(80);
  });

  // Exact per-MTok arithmetic: 1M tokens in every bucket makes each USD figure
  // the literal per-MTok price, so a price drift shows up as a failed assert.
  it.each([
    ['claude-fable-5-1', 'fable', 9.75, 72.75],
    ['claude-opus-5', 'opus', 4.5, 36.75],
    ['claude-sonnet-4-6', 'sonnet', 2.7, 22.05],
    ['claude-haiku-4-5', 'haiku', 0.9, 7.35],
  ])('prices 1M tokens per bucket for %s', (model, tier, saved, spent) => {
    const m = computeCacheMetrics(ONE_M_EACH, model, nowFn);
    expect(m.pricingTier).toBe(tier);
    expect(m.savedCostUsd).toBeCloseTo(saved, 6);
    expect(m.spentCostUsd).toBeCloseTo(spent, 6);
  });

  it('reports the sonnet fallback tier for unrecognized models', () => {
    expect(computeCacheMetrics(ONE_M_EACH, 'gpt-4', nowFn).pricingTier).toBe('sonnet');
    const blank = computeCacheMetrics(ONE_M_EACH, '', nowFn);
    expect(blank.pricingTier).toBe('sonnet');
    expect(blank.model).toBe('unknown');
    expect(blank.spentCostUsd).toBeCloseTo(22.05, 6);
  });

  it('stamps the catalog pricing version on every metric', () => {
    expect(computeCacheMetrics({}, 'opus', nowFn).pricingVersion).toBe(PRICING_VERSION);
    expect(typeof PRICING_VERSION).toBe('string');
  });

  it('uses Date.now by default when nowFn omitted', () => {
    const m = computeCacheMetrics({}, 'haiku');
    expect(typeof m.timestamp).toBe('string');
    expect(new Date(m.timestamp).getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('preserves model field, defaulting to "unknown"', () => {
    expect(computeCacheMetrics({}, '', nowFn).model).toBe('unknown');
    expect(computeCacheMetrics({}, 'opus', nowFn).model).toBe('opus');
  });

  it('returns a frozen object', () => {
    expect(Object.isFrozen(computeCacheMetrics({}, 'opus', nowFn))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// createEmptySession / foldMetrics
// ---------------------------------------------------------------------------

describe('createEmptySession', () => {
  it('returns a frozen zero-state session', () => {
    const s = createEmptySession();
    expect(Object.isFrozen(s)).toBe(true);
    expect(s.totalCacheReadTokens).toBe(0);
    expect(s.requestCount).toBe(0);
    expect(s.hitRate).toBe(0);
  });
});

describe('foldMetrics', () => {
  const sample = {
    cacheReadTokens: 100,
    cacheCreationTokens: 50,
    inputTokens: 50,
    outputTokens: 20,
    thinkingTokens: 5,
    savedCostUsd: 0.0015,
    spentCostUsd: 0.001,
    timestamp: '2026-04-25T00:00:00.000Z',
  };

  it('folds into the running totals immutably', () => {
    const s0 = createEmptySession();
    const s1 = foldMetrics(s0, sample);
    expect(s1.requestCount).toBe(1);
    expect(s1.totalCacheReadTokens).toBe(100);
    expect(s1.cumulativeSavedUsd).toBeCloseTo(0.0015, 6);
    expect(s1.hitRate).toBeCloseTo(100 / 200, 5);
    expect(Object.isFrozen(s1)).toBe(true);
    expect(s0.requestCount).toBe(0); // immutability
  });

  it('keeps the otel-facing session field set unchanged', () => {
    const s1 = foldMetrics(createEmptySession(), sample);
    expect(Object.keys(s1).sort()).toEqual([
      'cumulativeSavedUsd',
      'cumulativeSpentUsd',
      'hitRate',
      'requestCount',
      'totalCacheCreationTokens',
      'totalCacheReadTokens',
      'totalInputTokens',
      'totalOutputTokens',
      'totalThinkingTokens',
      'updatedAt',
    ]);
  });

  it('hitRate stays 0 when denominator is 0', () => {
    const empty = {
      cacheReadTokens: 0, cacheCreationTokens: 0, inputTokens: 0,
      outputTokens: 0, thinkingTokens: 0,
      savedCostUsd: 0, spentCostUsd: 0,
      timestamp: 'x',
    };
    expect(foldMetrics(createEmptySession(), empty).hitRate).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// resolveSessionPath / persistSession
// ---------------------------------------------------------------------------

describe('resolveSessionPath', () => {
  it('honors explicit pluginRoot', () => {
    const p = resolveSessionPath('/some/root');
    expect(p.replace(/\\/g, '/')).toContain('/some/root/runtime/cache-roi-session.json');
  });

  it('falls back to plugin root when omitted', () => {
    const p = resolveSessionPath();
    expect(p).toMatch(/cache-roi-session\.json$/);
  });
});

describe('persistSession', () => {
  it('returns true for a writable path (best-effort)', async () => {
    const root = process.cwd();
    const ok = await persistSession(createEmptySession(), root);
    expect(typeof ok).toBe('boolean');
  });

  it('never throws on filesystem errors — returns a boolean', async () => {
    // atomicWriteJson auto-creates parents, so we cannot force a `false` return
    // portably across platforms. The contract is "never throws"; verify shape.
    const ok = await persistSession(createEmptySession(), '/tmp/cache-roi-test-xyz');
    expect(typeof ok).toBe('boolean');
  });
});

// ---------------------------------------------------------------------------
// _extractUsage / _resolveModel
// ---------------------------------------------------------------------------

describe('_extractUsage', () => {
  it('reads response.usage', () => {
    expect(_extractUsage({ response: { usage: { input_tokens: 1 } } })).toEqual({ input_tokens: 1 });
  });

  it('falls through to context.response.usage', () => {
    expect(_extractUsage({ context: { response: { usage: { x: 1 } } } })).toEqual({ x: 1 });
  });

  it('falls through to context.usage', () => {
    expect(_extractUsage({ context: { usage: { y: 2 } } })).toEqual({ y: 2 });
  });

  it('falls through to context.cacheRoiInput', () => {
    expect(_extractUsage({ context: { cacheRoiInput: { z: 3 } } })).toEqual({ z: 3 });
  });

  it('returns null when nothing is available', () => {
    expect(_extractUsage({})).toBeNull();
    expect(_extractUsage(null)).toBeNull();
  });
});

describe('_resolveModel', () => {
  it('prefers context.backend.selected', () => {
    expect(_resolveModel({ context: { backend: { selected: 'opus' } } })).toBe('opus');
  });

  it('falls back through configured policy and response model', () => {
    expect(_resolveModel({ config: { modelPolicy: { default: 'sonnet' } } })).toBe('sonnet');
    expect(_resolveModel({ response: { model: 'haiku' } })).toBe('haiku');
  });

  it('returns "unknown" when nothing resolves', () => {
    expect(_resolveModel({})).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// createCacheRoiMiddleware
// ---------------------------------------------------------------------------

describe('createCacheRoiMiddleware', () => {
  let originalEnv;
  beforeEach(() => { originalEnv = process.env.ARTIBOT_CACHE_ROI; });
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.ARTIBOT_CACHE_ROI;
    else process.env.ARTIBOT_CACHE_ROI = originalEnv;
  });

  it('marks state as disabled when ARTIBOT_CACHE_ROI=0', async () => {
    process.env.ARTIBOT_CACHE_ROI = '0';
    const mw = createCacheRoiMiddleware({ persist: vi.fn() });
    const state = { context: {} };
    await mw(state);
    expect(state.context.cacheRoi).toEqual({ enabled: false });
  });

  it('explicit enabled=true overrides env disable', async () => {
    process.env.ARTIBOT_CACHE_ROI = '0';
    const persist = vi.fn().mockResolvedValue();
    const mw = createCacheRoiMiddleware({ enabled: true, persist });
    const state = {
      context: {
        backend: { selected: 'opus' },
        response: { usage: { input_tokens: 10, output_tokens: 5 } },
      },
      messageParts: [],
    };
    await mw(state);
    expect(state.context.cacheRoi.enabled).toBe(true);
    expect(state.context.cacheRoi.current).toBeDefined();
    expect(state.context.cacheRoi.current.pricingTier).toBe('opus');
    expect(persist).toHaveBeenCalledOnce();
    expect(state.messageParts.length).toBe(1);
  });

  it('marks "no-usage" when usage payload missing', async () => {
    const persist = vi.fn();
    const mw = createCacheRoiMiddleware({ persist });
    const state = { context: {} };
    await mw(state);
    expect(state.context.cacheRoi.skipped).toBe('no-usage');
    expect(persist).not.toHaveBeenCalled();
  });

  it('invokes the next() callback when provided', async () => {
    const next = vi.fn().mockResolvedValue();
    const mw = createCacheRoiMiddleware({ persist: vi.fn() });
    const state = { context: {} };
    await mw(state, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('uses provided initialSession to seed totals', async () => {
    const initial = { ...createEmptySession(), totalInputTokens: 999, requestCount: 5 };
    const persist = vi.fn().mockResolvedValue();
    const mw = createCacheRoiMiddleware({ persist, initialSession: initial });
    const state = {
      context: {
        backend: { selected: 'sonnet' },
        response: { usage: { input_tokens: 10, output_tokens: 5 } },
      },
    };
    await mw(state);
    expect(state.context.cacheRoi.session.totalInputTokens).toBe(1009);
    expect(state.context.cacheRoi.session.requestCount).toBe(6);
  });

  it('skips messageParts mutation if state lacks the array', async () => {
    const persist = vi.fn().mockResolvedValue();
    const mw = createCacheRoiMiddleware({ persist });
    const state = {
      context: {
        backend: { selected: 'opus' },
        response: { usage: { input_tokens: 1 } },
      },
    };
    await mw(state);
    expect(state.messageParts).toBeUndefined();
    expect(state.context.cacheRoi.current).toBeDefined();
  });

  it('returns state even when context is missing', async () => {
    process.env.ARTIBOT_CACHE_ROI = '0';
    const mw = createCacheRoiMiddleware({ persist: vi.fn() });
    const result = await mw({});
    expect(result).toEqual({});
  });
});
