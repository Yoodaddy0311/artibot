import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getLastEvent } from '../../../lib/core/event-bus.js';
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
  it('never sends a claude-* id to the substring step: exact ids resolve, off-catalog ones are unpriced', () => {
    // Off-catalog claude-* ids no longer reach the substring step: unpriced.
    expect(_resolvePricing('claude-fable-5')).toBeNull();
    expect(_resolvePricing('claude-opus-x')).toBeNull();
    expect(_resolvePricing('claude-sonnet-5')).toEqual(getPricing('sonnet'));
    expect(_resolvePricing('claude-haiku-4-5-20251001')).toEqual(getPricing('haiku'));
  });

  it('resolves an exact catalog id before any substring, so a legacy id keeps its own row', () => {
    // claude-opus-5 is a LEGACY opus id with its own official price row
    // (Claude Opus 5: 5 / 25 / 0.5 / 6.25). Substring 'opus' alone would bill
    // it at the Opus 5.5 tier row (4 / 20 / 0.2 / 5) instead.
    const legacy = _resolvePricing('claude-opus-5');
    expect(legacy).toEqual(getPricing('claude-opus-5'));
    expect(legacy.tier).toBe('opus');
    expect(legacy.id).toBe('claude-opus-5');
    expect(legacy.input).toBe(5);
    expect(legacy.cacheRead).toBe(0.5);
    // The current id is the tier row.
    expect(_resolvePricing('claude-opus-5-5')).toEqual(getPricing('opus'));
    expect(_resolvePricing('claude-opus-5-5').input).toBe(4);
  });

  it('strips a context variant and a snapshot date before the exact-id lookup', () => {
    expect(_resolvePricing('claude-opus-5[1m]')).toEqual(getPricing('claude-opus-5'));
    expect(_resolvePricing('claude-opus-5-5[1m]')).toEqual(getPricing('opus'));
    expect(_resolvePricing('CLAUDE-OPUS-5')).toEqual(getPricing('claude-opus-5'));
  });

  it('never exact-matches a role alias: it keeps the old unknown -> sonnet fallback', () => {
    // 'frontier' contains no tier substring, so it priced as sonnet before the
    // exact-id step existed; the exact step accepts model ids only.
    expect(_resolvePricing('frontier')).toEqual(getPricing('sonnet'));
    expect(_resolvePricing('opus')).toEqual(getPricing('opus'));
  });

  it('leaves older IDs the catalog does not list unpriced, e.g. claude-opus-4-8', () => {
    expect(_resolvePricing('claude-opus-4-8')).toBeNull();
    expect(_resolvePricing('claude-opus-4-7')).toBeNull();
  });

  it('prices fable input at 2.5x opus and fable cache read at only 1.25x opus (0.025x vs 0.05x rules)', () => {
    const fable = getPricing('fable');
    const opus = getPricing('opus');
    expect(fable.input).toBe(opus.input * 2.5);
    expect(fable.output).toBe(opus.output * 2.5);
    // Both cache reads are official footnote exceptions to the standard 0.1x:
    // fable 0.025x of $10 (0.25) and opus 0.05x of $4 (0.20). So fable's cache
    // read sits ABOVE opus's, but only 1.25x, while its input is 2.5x — the
    // gap a single "10% of input" rule would erase (it would give 1.00 vs 0.40).
    expect(fable.cacheRead).toBeCloseTo(opus.cacheRead * 1.25, 10);
    expect(fable.cacheRead).toBe(0.25);
    expect(opus.cacheRead).toBe(0.2);
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
    expect(_resolvePricing('CLAUDE-OPUS-X')).toBeNull();
    expect(_resolvePricing('CLAUDE-OPUS-5-5')).toEqual(getPricing('opus'));
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
    expect(_PRICING.opus.input).toBe(4);
    expect(_PRICING.haiku.cacheWrite).toBe(1.25);
    expect(Object.isFrozen(_PRICING)).toBe(true);
  });
});

// An off-catalog claude-* id has an official price this module does not know.
// Estimating it from the current tier row under-bills it (claude-opus-4-8 at
// the Opus 5.5 row), so it resolves to no price at all. Everything else —
// exact catalog ids and non-claude strings — must resolve exactly as before.
describe('_resolvePricing: off-catalog claude-* ids are unpriced', () => {
  it.each([
    'claude-opus-4-8',
    'claude-sonnet-4-6',
    'CLAUDE-OPUS-4-8[1m]',
    'claude-opus-4-8-20250101',
  ])('%s resolves to null, not a tier row', (model) => {
    expect(_resolvePricing(model)).toBeNull();
  });

  it.each([
    ['claude-opus-5-5', 'opus'],
    ['claude-opus-5-5[1m]', 'opus'],
    ['claude-opus-5-5-20260101', 'opus'],
    ['claude-opus-5', 'claude-opus-5'],
    ['opus', 'opus'],
    ['frontier', 'sonnet'],
    ['my-opus-proxy', 'opus'],
    ['gpt-4', 'sonnet'],
    ['', 'sonnet'],
    [null, 'sonnet'],
  ])('%s keeps its catalog row (%s)', (model, key) => {
    expect(_resolvePricing(model)).toEqual(getPricing(key));
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
    // opus / sonnet rows: PRICING_VERSION 2026-09-28 official prices.
    ['claude-opus-5-5', 'opus', 3.8, 29.2],
    // Legacy id, own official Claude Opus 5 row: saved 5 - 0.5, spent 5+0.5+6.25+25.
    ['claude-opus-5', 'opus', 4.5, 36.75],
    ['claude-sonnet-5', 'sonnet', 1.8, 14.7],
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
    expect(blank.spentCostUsd).toBeCloseTo(14.7, 6);
  });

  it('leaves an off-catalog claude id unpriced: tokens counted, dollars and stamp null', () => {
    const m = computeCacheMetrics(ONE_M_EACH, 'claude-opus-4-8', nowFn);
    expect(m.savedCostUsd).toBeNull();
    expect(m.spentCostUsd).toBeNull();
    expect(m.pricingTier).toBeNull();
    expect(m.pricingVersion).toBeNull();
    expect(m.cacheReadTokens).toBe(1_000_000);
    expect(m.hitRate).toBeCloseTo(1 / 3, 10);
    expect(m.model).toBe('claude-opus-4-8');
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
      'unpricedRequestCount',
      'updatedAt',
    ]);
  });

  it('counts an unpriced metric and keeps it out of the dollar sums', () => {
    const unpriced = { ...sample, savedCostUsd: null, spentCostUsd: null };
    const s1 = foldMetrics(foldMetrics(createEmptySession(), sample), unpriced);
    expect(s1.requestCount).toBe(2);
    expect(s1.unpricedRequestCount).toBe(1);
    expect(s1.totalCacheReadTokens).toBe(200);
    // Exactly the priced sample's dollars, never NaN or null. The unpriced
    // request shows up in unpricedRequestCount, not as a $0 entry.
    expect(s1.cumulativeSavedUsd).toBe(sample.savedCostUsd);
    expect(s1.cumulativeSpentUsd).toBe(sample.spentCostUsd);
  });

  it('treats a session persisted before unpricedRequestCount existed as 0', () => {
    const { unpricedRequestCount, ...legacy } = createEmptySession();
    expect(unpricedRequestCount).toBe(0);
    const unpriced = { ...sample, savedCostUsd: null, spentCostUsd: null };
    expect(foldMetrics(legacy, unpriced).unpricedRequestCount).toBe(1);
    expect(foldMetrics(legacy, sample).unpricedRequestCount).toBe(0);
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
  // Every write goes under a fresh OS temp dir. process.cwd() is the repo root
  // under `npm --prefix <plugin> exec`, where runtime/cache-roi-session.json is
  // a tracked file, and '/tmp/...' is C:\tmp on Windows — both leaked.
  let sandbox;
  beforeEach(() => { sandbox = mkdtempSync(path.join(os.tmpdir(), 'cache-roi-')); });
  afterEach(() => { rmSync(sandbox, { recursive: true, force: true }); });

  it('returns true for a writable path (best-effort)', async () => {
    const ok = await persistSession(createEmptySession(), sandbox);
    expect(typeof ok).toBe('boolean');
    expect(existsSync(resolveSessionPath(sandbox))).toBe(true);
  });

  it('never throws on filesystem errors — returns a boolean', async () => {
    // atomicWriteJson auto-creates parents, so we cannot force a `false` return
    // portably across platforms. The contract is "never throws"; verify shape.
    const ok = await persistSession(createEmptySession(), path.join(sandbox, 'nested', 'root'));
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

  it('folds an unpriced response into the session without dollars or a throw', async () => {
    const persist = vi.fn().mockResolvedValue();
    const mw = createCacheRoiMiddleware({ enabled: true, persist });
    const state = {
      context: {},
      response: { model: 'claude-sonnet-4-6', usage: { input_tokens: 10, output_tokens: 5 } },
      messageParts: [],
    };
    await mw(state);
    expect(state.context.cacheRoi.current.spentCostUsd).toBeNull();
    expect(state.context.cacheRoi.session.unpricedRequestCount).toBe(1);
    expect(state.context.cacheRoi.session.requestCount).toBe(1);
    expect(state.context.cacheRoi.session.cumulativeSpentUsd).toBe(0);
    expect(persist).toHaveBeenCalledOnce();
    expect(state.messageParts).toEqual(['cache=0%']);
    expect(getLastEvent('feature:cache-roi').detail).toBe('hit=0% saved=unpriced');
  });

  it('returns state even when context is missing', async () => {
    process.env.ARTIBOT_CACHE_ROI = '0';
    const mw = createCacheRoiMiddleware({ persist: vi.fn() });
    const result = await mw({});
    expect(result).toEqual({});
  });
});
