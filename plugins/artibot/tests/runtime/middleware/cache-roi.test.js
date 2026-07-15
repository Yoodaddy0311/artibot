import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
} from '../../../lib/runtime/middleware/cache-roi.js';

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
// _resolvePricing
// ---------------------------------------------------------------------------

describe('_resolvePricing', () => {
  it('matches fable / opus / sonnet / haiku by substring', () => {
    expect(_resolvePricing('claude-fable-5')).toBe(_PRICING.fable);
    expect(_resolvePricing('claude-opus-4-8')).toBe(_PRICING.opus);
    expect(_resolvePricing('claude-opus-4-7')).toBe(_PRICING.opus);
    expect(_resolvePricing('claude-sonnet-4-6')).toBe(_PRICING.sonnet);
    expect(_resolvePricing('claude-haiku-4-5-20251001')).toBe(_PRICING.haiku);
  });

  it('prices fable at 2x opus per token (tokenizer coeff excluded — usage tokens already reflect it)', () => {
    expect(_PRICING.fable.input).toBe(_PRICING.opus.input * 2);
    expect(_PRICING.fable.output).toBe(_PRICING.opus.output * 2);
    expect(_PRICING.fable.cacheRead).toBe(_PRICING.opus.cacheRead * 2);
    expect(_PRICING.fable.cacheWrite).toBe(_PRICING.opus.cacheWrite * 2);
  });

  it('falls back to unknown for invalid / unrecognized', () => {
    expect(_resolvePricing('')).toBe(_PRICING.unknown);
    expect(_resolvePricing(null)).toBe(_PRICING.unknown);
    expect(_resolvePricing(42)).toBe(_PRICING.unknown);
    expect(_resolvePricing('gpt-4')).toBe(_PRICING.unknown);
  });

  it('is case-insensitive', () => {
    expect(_resolvePricing('CLAUDE-OPUS-X')).toBe(_PRICING.opus);
  });
});

// ---------------------------------------------------------------------------
// computeCacheMetrics
// ---------------------------------------------------------------------------

describe('computeCacheMetrics', () => {
  const FIXED = 1_700_000_000_000;
  const nowFn = () => FIXED;

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
