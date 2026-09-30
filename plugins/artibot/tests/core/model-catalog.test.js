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
  ID_PRICES,
  listTiers,
  MODELS,
  PRICING_SOURCE,
  PRICING_VERSION,
  resolveRole,
  ROLE_ALIASES,
  tierForModelId,
} from '../../lib/core/model-catalog.js';

// Harness model enum whitelist — the tiers Claude Code Agent/Task `model` accepts.
const ENUM_WHITELIST = ['sonnet', 'opus', 'haiku', 'fable'];

/**
 * Official per-MTok price table (platform.claude.com pricing page; haiku and
 * fable verified 2026-09-12, opus and sonnet re-verified 2026-09-28). Literal
 * pins: these numbers are copied from the page, NOT derived from each other,
 * so a future "simplification" that computes cache prices from a single
 * multiplier breaks here instead of silently mispricing fable (0.025x) or
 * opus (0.05x), whose cache-read multipliers are not the usual 0.1x.
 */
const PRICE_TABLE = [
  { tier: 'haiku', id: 'claude-haiku-4-5', input: 1, output: 5, cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2 },
  // 2026-09-28: Sonnet 5 공식가. 2/10 이 표준가로 확정(9/1 예정 인상 취소 — 공식 각주).
  // 2026-09-29: the tier id is now Sonnet 5.5 (claude-sonnet-5 is its legacy id). Its
  // input / output / cache read are the claude-api skill price table (cached
  // 2026-09-25): 2 / 10 / 0.2, identical to Sonnet 5. That table does not list cache
  // writes, so 2.5 / 4 are the standard 1.25x / 2x of input (multiplier-derived).
  { tier: 'sonnet', id: 'claude-sonnet-5-5', input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4 },
  // 2026-09-28: Opus 5.5 공식가. cache read 0.2 는 0.05x base input(공식 각주), 0.1x 아님.
  { tier: 'opus', id: 'claude-opus-5-5', input: 4, output: 20, cacheRead: 0.2, cacheWrite5m: 5, cacheWrite1h: 8 },
  { tier: 'fable', id: 'claude-fable-5-1', input: 10, output: 50, cacheRead: 0.25, cacheWrite5m: 12.5, cacheWrite1h: 20 },
];

/**
 * What the catalog's OWN comments say about where each price row came from, typed
 * out: the PRICING_VERSION notes (2026-09-28: opus and sonnet read off
 * PRICING_SOURCE, haiku and fable re-read the same day and already matched;
 * 2026-09-29: sonnet 5.5 compared with the claude-api skill price table, cached
 * 2026-09-25, whose table lists no cache writes), the sonnet / opus row comments and
 * the ID_PRICES comment (Claude Opus 5 row, official page, 2026-09-28). Literal on
 * purpose, and NOT imported: the structured field must agree with the prose, and a
 * value copied from the module under test would agree with itself.
 */
const OFFICIAL_2026_09_28 = {
  kind: 'official-table', ref: PRICING_SOURCE, checkedAt: '2026-09-28', derivedColumns: [],
};
const SONNET_SOURCE = {
  kind: 'skill-table',
  ref: 'claude-api skill price table, cached 2026-09-25',
  checkedAt: '2026-09-29',
  derivedColumns: ['priceCacheWrite5mPerMTok', 'priceCacheWrite1hPerMTok'],
};

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
      expect(getModel('opus').id).toBe('claude-opus-5-5');
      expect(getModel('sonnet').id).toBe('claude-sonnet-5-5');
      expect(getModel('haiku').id).toBe('claude-haiku-4-5');
    });

    it('marks Opus 5.5 thinking as always-on (it cannot be disabled), prompt style unchanged', () => {
      // 2026-09-28 (D3): {type:'disabled'} and budget_tokens return 400 on
      // Opus 5.5 at every effort, so 'adaptive' overstated what a caller can do.
      expect(getModel('opus').thinkingMode).toBe('always-on');
      expect(getModel('opus').promptStyle).toBe('prescriptive');
      expect(getModel('sonnet').thinkingMode).toBe('adaptive');
    });

    it('marks Haiku 4.5 thinking as extended (budget_tokens only, no adaptive)', () => {
      // claude-api skill, "Thinking & Effort": adaptive on every current model
      // except Haiku 4.5, which still takes {type:'enabled', budget_tokens}.
      expect(getModel('haiku').thinkingMode).toBe('extended');
    });

    it('pins official output limits: Sonnet 5 128K, Haiku 4.5 64K', () => {
      // claude-api skill shared/models.md (Sonnet 5 row: 128K; Haiku 4.5 row: 64K).
      // 2026-09-29: the tier id moved to Sonnet 5.5 and this limit was carried
      // over as is. The row cited is Sonnet 5's; nobody re-read it for 5.5.
      expect(getModel('sonnet').outLimit).toBe(128_000);
      expect(getModel('haiku').outLimit).toBe(64_000);
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

    it('fable = (10/4) * 1.3 = 3.25', () => {
      expect(getCostFactor('fable')).toBeCloseTo(3.25, 10);
    });

    it('sonnet = (2/4) * 1.0 = 0.5', () => {
      expect(getCostFactor('sonnet')).toBeCloseTo(0.5, 10);
    });

    it('haiku = (1/4) * 1.0 = 0.25', () => {
      expect(getCostFactor('haiku')).toBeCloseTo(0.25, 10);
    });

    it('every factor divides by the Opus 5.5 input price (4), not the old claude-opus-5 row (5)', () => {
      // 2026-09-28: the opus row moved to Opus 5.5 official pricing. opus is
      // the baseline TIER, so that one edit moved every other tier's factor.
      expect(BASELINE_TIER).toBe('opus');
      expect(getModel(BASELINE_TIER).priceInPerMTok).toBe(4);
      const factors = Object.fromEntries(listTiers().map((t) => [t, getCostFactor(t)]));
      expect(factors.haiku).toBeCloseTo(0.25, 10);
      expect(factors.sonnet).toBeCloseTo(0.5, 10);
      expect(factors.opus).toBe(1);
      expect(factors.fable).toBeCloseTo(3.25, 10);
    });

    it('returns 1.0 for unknown tier / bad input', () => {
      expect(getCostFactor('mythos')).toBe(1.0);
      expect(getCostFactor(null)).toBe(1.0);
    });
  });

  describe('price table (verified against PRICING_SOURCE, PRICING_VERSION 2026-09-28)', () => {
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

    it('opus cache reads are 0.05x input, NOT the usual 0.1x', () => {
      // Official footnote on the Opus 5.5 row: cache read $0.20 = 0.05x the
      // $4 base input. A "fix" to the standard 0.1x would double it to 0.4.
      const opus = getModel('opus');
      expect(opus.priceCacheReadPerMTok).toBe(0.2);
      expect(opus.priceCacheReadPerMTok).toBeCloseTo(
        0.05 * opus.priceInPerMTok,
        10,
      );
      expect(opus.priceCacheReadPerMTok).not.toBeCloseTo(
        0.1 * opus.priceInPerMTok,
        10,
      );
    });

    it.each(['haiku', 'sonnet'])(
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
        // it (and getCostFactor's 3.25) is an owner decision.
        expect(getModel(tier).tokenizerCoeffMeasured).toBe(false);
      },
    );
  });

  describe('getPricing()', () => {
    it('returns the full pricing shape for a tier', () => {
      expect(getPricing('opus')).toEqual({
        tier: 'opus',
        id: 'claude-opus-5-5',
        input: 4,
        output: 20,
        cacheRead: 0.2,
        cacheWrite5m: 5,
        cacheWrite1h: 8,
        measured: true,
        version: PRICING_VERSION,
        source: OFFICIAL_2026_09_28,
      });
    });

    it('resolves role aliases (frontier → opus, deep-async → fable)', () => {
      expect(getPricing('frontier').tier).toBe('opus');
      expect(getPricing('frontier').id).toBe('claude-opus-5-5');
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

  describe('legacyIds (extra exact ids that still resolve to the tier)', () => {
    it('opus keeps claude-opus-5 as its only legacy id', () => {
      expect(getModel('opus').legacyIds).toEqual(['claude-opus-5']);
    });

    it.each(['haiku', 'fable'])(
      '%s carries an empty legacyIds array (same shape on every tier)',
      (tier) => {
        expect(getModel(tier).legacyIds).toEqual([]);
      },
    );

    it('sonnet keeps claude-sonnet-5 as its only legacy id; claude-sonnet-5-5 is the current id', () => {
      // 2026-09-29: the host serves `claude-sonnet-5-5` for the sonnet tier and
      // that id was dropped as an unresolved model, so its usage never became a
      // receipt. An earlier edit of the same day made it resolve as a legacy
      // id; this promotes it to `id`, the way opus moved to claude-opus-5-5 on
      // 2026-09-23. The pre-5.5 id stays in the list so old transcripts and
      // ledger rows keep tier sonnet.
      expect(getModel('sonnet').id).toBe('claude-sonnet-5-5');
      expect(getModel('sonnet').legacyIds).toEqual(['claude-sonnet-5']);
    });

    it('every tier has a frozen legacyIds array of non-empty strings', () => {
      for (const tier of listTiers()) {
        const { legacyIds } = getModel(tier);
        expect(Array.isArray(legacyIds)).toBe(true);
        expect(Object.isFrozen(legacyIds)).toBe(true);
        for (const id of legacyIds) {
          expect(typeof id).toBe('string');
          expect(id.length).toBeGreaterThan(0);
        }
      }
    });

    it('no id (current or legacy) names two tiers or repeats inside one tier', () => {
      // A reverse index built from these would otherwise silently let the
      // last writer win and hand a receipt the wrong tier's price.
      const all = listTiers().flatMap((t) => [getModel(t).id, ...getModel(t).legacyIds]);
      expect(new Set(all).size).toBe(all.length);
    });

    it('a legacy id is never the current id of its own tier', () => {
      for (const tier of listTiers()) {
        const m = getModel(tier);
        expect(m.legacyIds).not.toContain(m.id);
      }
    });

    it('getPricing still names the current id, not a legacy one', () => {
      expect(getPricing('opus').id).toBe('claude-opus-5-5');
      expect(getPricing('sonnet').id).toBe('claude-sonnet-5-5');
    });
  });

  describe('per-id price rows (ID_PRICES)', () => {
    it('prices the legacy id claude-opus-5 at the official Claude Opus 5 row', () => {
      // Literal pin (official pricing page row, fetched 2026-09-28 KST). The
      // opus TIER moved to Opus 5.5; this id keeps the price it was billed at.
      expect(getPricing('claude-opus-5')).toEqual({
        tier: 'opus',
        id: 'claude-opus-5',
        input: 5,
        output: 25,
        cacheRead: 0.5,
        cacheWrite5m: 6.25,
        cacheWrite1h: 10,
        measured: true,
        version: PRICING_VERSION,
        source: OFFICIAL_2026_09_28,
      });
    });

    it('prices the legacy id claude-sonnet-5 at the literal Sonnet 5 row, which today equals the tier row', () => {
      // Literal pin (Sonnet 5 row, official pricing page, fetched 2026-09-28
      // KST). The sonnet TIER moved to Sonnet 5.5 on 2026-09-29 with identical
      // numbers, so this id needs no ID_PRICES row today (the keys pin below
      // lists the rows that exist). It is priced by the tier row, which means
      // a later edit of that row would silently reprice every old
      // claude-sonnet-5 receipt: if this pin goes red, add an ID_PRICES row
      // for the id (the claude-opus-5 pattern) instead of editing the numbers
      // here.
      expect(getPricing('claude-sonnet-5')).toEqual({
        tier: 'sonnet',
        id: 'claude-sonnet-5',
        input: 2,
        output: 10,
        cacheRead: 0.2,
        cacheWrite5m: 2.5,
        cacheWrite1h: 4,
        measured: true,
        version: PRICING_VERSION,
        // No ID_PRICES row for this id, so it reports the TIER row's source.
        source: SONNET_SOURCE,
      });
    });

    it('prices a current id at its tier row and reports the id that was asked for', () => {
      for (const tier of listTiers()) {
        const { id } = getModel(tier);
        expect(getPricing(id)).toEqual(getPricing(tier));
      }
      expect(getPricing('claude-opus-5-5').input).toBe(4);
      expect(getPricing('claude-sonnet-5-5').input).toBe(2);
    });

    it('leaves every tier and role lookup exactly as before (no id row leaks in)', () => {
      expect(getPricing('opus').id).toBe('claude-opus-5-5');
      expect(getPricing('opus').input).toBe(4);
      expect(getPricing('frontier')).toEqual(getPricing('opus'));
    });

    it('keys ID_PRICES only by legacy ids, so tier resolution stays in legacyIds', () => {
      // A row for a CURRENT id would be a second price for the tier's own id;
      // a row for an unknown id would price something no tier resolves.
      const legacy = listTiers().flatMap((t) => getModel(t).legacyIds);
      for (const id of Object.keys(ID_PRICES)) {
        expect(legacy).toContain(id);
      }
      expect(Object.keys(ID_PRICES)).toEqual(['claude-opus-5']);
    });

    it('is deep-frozen and every row is measured with five finite prices', () => {
      expect(Object.isFrozen(ID_PRICES)).toBe(true);
      for (const row of Object.values(ID_PRICES)) {
        expect(Object.isFrozen(row)).toBe(true);
        expect(row.priceMeasured).toBe(true);
        for (const field of [
          'priceInPerMTok',
          'priceOutPerMTok',
          'priceCacheReadPerMTok',
          'priceCacheWrite5mPerMTok',
          'priceCacheWrite1hPerMTok',
        ]) {
          expect(Number.isFinite(row[field]) && row[field] > 0).toBe(true);
        }
      }
    });

    it('resolves exact model ids (current or legacy) to a tier, and nothing else', () => {
      expect(tierForModelId('claude-opus-5-5')).toBe('opus');
      expect(tierForModelId('claude-opus-5')).toBe('opus');
      expect(tierForModelId('claude-fable-5-1')).toBe('fable');
      // Tier and role names are not model ids; near-misses do not prefix-match.
      for (const bad of ['opus', 'frontier', 'claude-opus-5-6', 'claude-opus-5[1m]',
        'toString', '', null, 42]) {
        expect(tierForModelId(bad)).toBeNull();
      }
      expect(getPricing('claude-opus-5-6')).toBeNull();
    });
  });

  describe('claude-sonnet-5-5 (the current sonnet id, the one the host serves)', () => {
    it('resolves to the sonnet tier, and the pre-5.5 id still does', () => {
      expect(tierForModelId('claude-sonnet-5-5')).toBe('sonnet');
      // Old receipt rows and transcripts written against claude-sonnet-5 keep
      // their tier.
      expect(tierForModelId('claude-sonnet-5')).toBe('sonnet');
    });

    it('does not prefix-, qualifier- or case-match near misses', () => {
      // Exact-string lookup: the receipt layer strips `[1m]` and 8-digit
      // snapshots itself before asking, so the catalog must not tolerate them.
      for (const bad of [
        'claude-sonnet-5-6', 'claude-sonnet-5-50', 'claude-sonnet-55',
        'claude-sonnet-5-5[1m]', 'claude-sonnet-5-5-20260929',
        'CLAUDE-SONNET-5-5', 'sonnet-5-5', 'claude-sonnet-5-5 ',
      ]) {
        expect(tierForModelId(bad), bad).toBeNull();
      }
      expect(getPricing('claude-sonnet-5-6')).toBeNull();
    });

    it('is the sonnet tier row itself, and the row carries the Sonnet 5.5 numbers', () => {
      // WHAT THIS PINS: the tier row is the one Sonnet 5.5 is billed at. Where
      // the numbers come from: input 2 / output 10 / cache read 0.2 are the
      // claude-api skill price table (cached 2026-09-25), identical to the
      // Sonnet 5 row read off PRICING_SOURCE on 2026-09-28. That table does not
      // list cache writes, so 2.5 / 4 are the standard 1.25x / 2x of input
      // (multiplier-derived, not read for 5.5). A real difference between the
      // two models later goes red here on purpose: move the tier, bump
      // PRICING_VERSION, freeze the outgoing row, and give claude-sonnet-5 its
      // own ID_PRICES row.
      expect(getPricing('claude-sonnet-5-5')).toEqual(getPricing('sonnet'));
      expect(getPricing('claude-sonnet-5-5')).toMatchObject({
        tier: 'sonnet',
        id: 'claude-sonnet-5-5',
        input: 2,
        output: 10,
        cacheRead: 0.2,
        cacheWrite5m: 2.5,
        cacheWrite1h: 4,
        measured: true,
      });
    });

    it('keeps the pre-5.5 id priced at the same numbers, reporting the id that was asked for', () => {
      expect(getPricing('claude-sonnet-5')).toEqual({
        ...getPricing('sonnet'),
        id: 'claude-sonnet-5',
      });
      expect(getPricing('balanced')).toEqual(getPricing('sonnet'));
    });
  });

  /**
   * `priceSource`: where the five price columns of a row were read from, as data a
   * caller can read instead of a code comment.
   *
   * WHAT THIS BLOCK CANNOT SEE. Whether any of it is TRUE: a date, a label and a
   * kind are typed by whoever edits the catalog and no test can re-read the page
   * or the skill table (data policy: nothing here fetches anything). The literal
   * pins below agree with the catalog's own prose as of 2026-09-30; they do not
   * prove the prose. The official-table date is tied to PRICING_VERSION only for
   * tier rows, because that is what `priceMeasured` already claims.
   */
  describe('priceSource (where each price row came from)', () => {
    const SOURCE_KINDS = ['official-table', 'skill-table'];
    const PRICE_COLUMNS = [
      'priceInPerMTok',
      'priceOutPerMTok',
      'priceCacheReadPerMTok',
      'priceCacheWrite5mPerMTok',
      'priceCacheWrite1hPerMTok',
    ];
    // The only derivation this catalog documents: a cache-write column as a
    // standard multiple of input. Anything else that wants to be `derived` has to
    // be added here, on purpose.
    const DERIVED_MULTIPLES = { priceCacheWrite5mPerMTok: 1.25, priceCacheWrite1hPerMTok: 2 };

    const rows = [
      ...listTiers().map((tier) => [`tier ${tier}`, getModel(tier)]),
      ...Object.entries(ID_PRICES).map(([id, row]) => [`id ${id}`, row]),
    ];
    const rowOf = Object.fromEntries(rows);

    const EVIDENCE = {
      'tier haiku': OFFICIAL_2026_09_28,
      'tier sonnet': SONNET_SOURCE,
      'tier opus': OFFICIAL_2026_09_28,
      'tier fable': OFFICIAL_2026_09_28,
      'id claude-opus-5': OFFICIAL_2026_09_28,
    };

    it('covers every tier row and every ID_PRICES row, and the evidence table names exactly those rows', () => {
      // The denominator: a row added to the catalog without a pin here is red, and
      // so is a pin for a row that is gone.
      expect(rows.map(([label]) => label).sort()).toEqual(Object.keys(EVIDENCE).sort());
      expect(rows).toHaveLength(5);
    });

    it.each(rows)('%s carries a frozen priceSource with exactly kind, ref, checkedAt, derivedColumns', (_label, row) => {
      const source = row.priceSource;
      expect(source).toBeTypeOf('object');
      expect(Object.keys(source).sort()).toEqual(['checkedAt', 'derivedColumns', 'kind', 'ref']);
      expect(Object.isFrozen(source)).toBe(true);
      expect(Object.isFrozen(source.derivedColumns)).toBe(true);
    });

    it.each(rows)('%s: kind is in the closed vocabulary, ref is a scheme-less label, checkedAt is a real date', (_label, row) => {
      const { kind, ref, checkedAt } = row.priceSource;
      expect(SOURCE_KINDS).toContain(kind);
      expect(typeof ref).toBe('string');
      expect(ref.length).toBeGreaterThan(0);
      // The outbound guard fails model-catalog.js on any URL literal, comments and
      // strings included: a label is a bare path or a name, never a link.
      expect(ref).not.toMatch(/^[a-z][a-z0-9+.-]*:\/\//i);
      expect(checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(new Date(`${checkedAt}T00:00:00Z`).toISOString().slice(0, 10)).toBe(checkedAt);
    });

    it('the JSDoc typedefs name the same kinds as the vocabulary (a new kind lands in both)', () => {
      const typedefs = [...catalogSrc.matchAll(/^\s*\*\s+kind: ('[^']+'(?:\|'[^']+')*),$/gm)];
      // One for MODELS and one for ID_PRICES.
      expect(typedefs.length).toBeGreaterThanOrEqual(2);
      for (const match of typedefs) {
        expect(match[1].split('|').map((s) => s.slice(1, -1)).sort()).toEqual([...SOURCE_KINDS].sort());
      }
    });

    it.each(rows)('%s: derivedColumns are unique price columns, and each is really the standard multiple of input', (_label, row) => {
      const { derivedColumns } = row.priceSource;
      expect(new Set(derivedColumns).size).toBe(derivedColumns.length);
      for (const column of derivedColumns) {
        expect(PRICE_COLUMNS).toContain(column);
        // Closed allowlist: a derivation this test does not know is red, not waved through.
        expect(Object.keys(DERIVED_MULTIPLES)).toContain(column);
        expect(row[column]).toBeCloseTo(DERIVED_MULTIPLES[column] * row.priceInPerMTok, 10);
      }
      // A row that read nothing would claim a source for numbers nobody looked at.
      expect(derivedColumns.length).toBeLessThan(PRICE_COLUMNS.length);
    });

    it.each(Object.entries(EVIDENCE))('%s carries the source its own comments evidence', (label, expected) => {
      expect(rowOf[label].priceSource).toEqual(expected);
    });

    it('an official-table source names PRICING_SOURCE, the page the catalog says its price columns come from', () => {
      for (const [, row] of rows) {
        if (row.priceSource.kind === 'official-table') expect(row.priceSource.ref).toBe(PRICING_SOURCE);
      }
    });

    it('a current tier row read off the official page was read on PRICING_VERSION (what priceMeasured already says)', () => {
      // `priceMeasured: true` is defined as "compared against PRICING_SOURCE on
      // PRICING_VERSION". PRICING_VERSION moved but a row keeps an older date: either
      // that row was not re-read (record that, do not copy the new date over it) or
      // priceSource was forgotten. Legacy id rows are exempt: they are frozen history.
      for (const tier of listTiers()) {
        const { priceSource, priceMeasured } = getModel(tier);
        if (priceMeasured === true && priceSource.kind === 'official-table') {
          expect(priceSource.checkedAt, `tier ${tier}`).toBe(PRICING_VERSION);
        }
      }
    });

    it('only the sonnet tier reads its base columns from the skill table, and only its cache writes are derived', () => {
      for (const tier of listTiers()) {
        const { kind, derivedColumns } = getModel(tier).priceSource;
        expect(kind === 'skill-table', tier).toBe(tier === 'sonnet');
        expect(derivedColumns.length > 0, tier).toBe(tier === 'sonnet');
      }
    });

    it('getPricing reports the source of the row that prices the key', () => {
      expect(getPricing('opus').source).toEqual(OFFICIAL_2026_09_28);
      expect(getPricing('frontier').source).toBe(MODELS.opus.priceSource);
      expect(getPricing('claude-opus-5-5').source).toBe(MODELS.opus.priceSource);
      // A legacy id with its own ID_PRICES row reads THAT row, not its tier's.
      expect(getPricing('claude-opus-5').source).toBe(ID_PRICES['claude-opus-5'].priceSource);
      expect(getPricing('claude-opus-5').source).not.toBe(MODELS.opus.priceSource);
      // A legacy id with no row of its own is priced by the tier row and reports the
      // tier row's source: the row's latest comparison, not one made for that id.
      expect(getPricing('claude-sonnet-5').source).toBe(MODELS.sonnet.priceSource);
      expect(getPricing('claude-sonnet-5-5').source).toBe(MODELS.sonnet.priceSource);
    });

    it('every getPricing record carries a frozen source, for every tier, role and id', () => {
      for (const key of [...listTiers(), ...Object.keys(ROLE_ALIASES), 'claude-opus-5', 'claude-sonnet-5']) {
        const { source } = getPricing(key);
        expect(source, key).toBeTruthy();
        expect(Object.isFrozen(source), key).toBe(true);
      }
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

    it('(f) every thinkingMode is in the typedef vocabulary (allowlist, fail-closed)', () => {
      const THINKING_MODES = ['adaptive', 'always-on', 'extended'];
      for (const tier of listTiers()) {
        expect(THINKING_MODES).toContain(getModel(tier).thinkingMode);
      }
      // The JSDoc typedef must name the same set, so a new value lands in both.
      const typedef = catalogSrc.match(/^\s*\*\s+thinkingMode: ('[^']+'(?:\|'[^']+')*),$/m);
      expect(typedef).not.toBeNull();
      expect(typedef[1].split('|').map((s) => s.slice(1, -1)).sort()).toEqual(
        [...THINKING_MODES].sort(),
      );
    });
  });
});
