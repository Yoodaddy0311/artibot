import { describe, expect, it } from 'vitest';
import {
  anonymizeId,
  createInstanceHash,
  qualifyPattern,
  computeRankingScore,
  rankPatterns,
  buildContribution,
  generateWeeklyTop,
  _MIN_SHARE_SUCCESS_RATE,
  _MIN_USAGE_COUNT,
  _MAX_BATCH_SIZE,
  _PII_KEYS,
  _stripPiiFromMetadata,
} from '../../lib/swarm/collective-hub.js';

const baseConfig = { optIn: true, shareTypes: ['tool'], minSuccessRate: 0.6, minUsageCount: 5 };

function makePattern(overrides = {}) {
  return {
    id: 'test-id',
    type: 'tool',
    signature: 'test-sig',
    successRate: 0.8,
    usageCount: 10,
    contributorCount: 3,
    score: 0,
    lastUpdated: '2026-03-20T00:00:00.000Z',
    ...overrides,
  };
}

describe('collective-hub', () => {
  describe('anonymizeId', () => {
    it('returns a 64-char hex SHA-256 hash', () => {
      const hash = anonymizeId('test-data');
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('same input produces same hash', () => {
      expect(anonymizeId('abc')).toBe(anonymizeId('abc'));
    });

    it('different inputs produce different hashes', () => {
      expect(anonymizeId('a')).not.toBe(anonymizeId('b'));
    });
  });

  describe('createInstanceHash', () => {
    it('produces consistent hash for same inputs', () => {
      const h1 = createInstanceHash({ hostname: 'mypc', username: 'user' });
      const h2 = createInstanceHash({ hostname: 'mypc', username: 'user' });
      expect(h1).toBe(h2);
    });

    it('produces different hash for different inputs', () => {
      const h1 = createInstanceHash({ hostname: 'pc1' });
      const h2 = createInstanceHash({ hostname: 'pc2' });
      expect(h1).not.toBe(h2);
    });

    it('handles missing deps gracefully', () => {
      const hash = createInstanceHash();
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  describe('qualifyPattern', () => {
    it('qualifies pattern meeting all thresholds', () => {
      const result = qualifyPattern({ successRate: 0.8, usageCount: 10 }, baseConfig);
      expect(result.qualified).toBe(true);
      expect(result.reasons).toEqual([]);
    });

    it('rejects when opt-in is off', () => {
      const result = qualifyPattern({ successRate: 0.8, usageCount: 10 }, { ...baseConfig, optIn: false });
      expect(result.qualified).toBe(false);
      expect(result.reasons[0]).toContain('not opted in');
    });

    it('rejects low success rate', () => {
      const result = qualifyPattern({ successRate: 0.3, usageCount: 10 }, baseConfig);
      expect(result.qualified).toBe(false);
      expect(result.reasons[0]).toContain('Success rate');
    });

    it('rejects low usage count', () => {
      const result = qualifyPattern({ successRate: 0.8, usageCount: 2 }, baseConfig);
      expect(result.qualified).toBe(false);
      expect(result.reasons[0]).toContain('Usage count');
    });
  });

  describe('computeRankingScore', () => {
    it('returns score between 0 and 1', () => {
      const score = computeRankingScore(makePattern(), { maxUsage: 10, now: '2026-03-29T00:00:00.000Z' });
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    });

    it('higher success rate produces higher score', () => {
      const ctx = { maxUsage: 10, now: '2026-03-29T00:00:00.000Z' };
      const high = computeRankingScore(makePattern({ successRate: 0.9 }), ctx);
      const low = computeRankingScore(makePattern({ successRate: 0.3 }), ctx);
      expect(high).toBeGreaterThan(low);
    });

    it('more recent patterns score higher', () => {
      const ctx = { maxUsage: 10, now: '2026-03-29T00:00:00.000Z' };
      const recent = computeRankingScore(makePattern({ lastUpdated: '2026-03-28T00:00:00.000Z' }), ctx);
      const old = computeRankingScore(makePattern({ lastUpdated: '2025-12-01T00:00:00.000Z' }), ctx);
      expect(recent).toBeGreaterThan(old);
    });
  });

  describe('rankPatterns', () => {
    it('returns top N sorted by score', () => {
      const patterns = [
        makePattern({ successRate: 0.5, usageCount: 2 }),
        makePattern({ successRate: 0.9, usageCount: 20 }),
        makePattern({ successRate: 0.7, usageCount: 10 }),
      ];
      const top = rankPatterns(patterns, 2, { now: '2026-03-29T00:00:00.000Z' });
      expect(top).toHaveLength(2);
      expect(top[0].score).toBeGreaterThanOrEqual(top[1].score);
    });

    it('returns empty for empty input', () => {
      expect(rankPatterns([], 10)).toEqual([]);
      expect(rankPatterns(null, 10)).toEqual([]);
    });
  });

  describe('buildContribution', () => {
    it('builds batch from qualifying patterns', () => {
      const patterns = [
        { type: 'tool', name: 'read-file', successRate: 0.9, usageCount: 15 },
        { type: 'tool', name: 'low-usage', successRate: 0.8, usageCount: 1 },
      ];
      const batch = buildContribution(patterns, baseConfig, { hostname: 'test' });

      expect(batch).not.toBeNull();
      expect(batch.patterns).toHaveLength(1); // only first qualifies
      expect(batch.optIn).toBe(true);
      expect(batch.instanceHash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('returns null when opt-in is off', () => {
      expect(buildContribution([{ successRate: 1, usageCount: 100 }], { optIn: false })).toBeNull();
    });

    it('returns null for empty patterns', () => {
      expect(buildContribution([], baseConfig)).toBeNull();
    });

    it('strips PII from metadata', () => {
      const patterns = [{
        type: 'tool',
        name: 'test',
        successRate: 0.9,
        usageCount: 10,
        metadata: { user: 'secret', context: 'safe' },
      }];
      const batch = buildContribution(patterns, baseConfig);
      expect(batch.patterns[0].metadata.user).toBeUndefined();
      expect(batch.patterns[0].metadata.context).toBe('safe');
    });
  });

  describe('generateWeeklyTop', () => {
    it('returns ranked patterns with title', () => {
      const patterns = [
        makePattern({ successRate: 0.9, usageCount: 50 }),
        makePattern({ successRate: 0.5, usageCount: 5 }),
      ];
      const result = generateWeeklyTop(patterns, 5, { now: '2026-03-29T00:00:00.000Z' });
      expect(result.title).toContain('Top 5');
      expect(result.patterns).toHaveLength(2);
      expect(result.generatedAt).toBeTruthy();
    });
  });

  describe('_stripPiiFromMetadata', () => {
    it('removes PII keys and keeps safe keys', () => {
      const result = _stripPiiFromMetadata({
        user: 'alice',
        email: 'alice@example.com',
        hostname: 'mypc',
        toolName: 'Read',
        context: 'engineering',
      });
      expect(result.user).toBeUndefined();
      expect(result.email).toBeUndefined();
      expect(result.hostname).toBeUndefined();
      expect(result.toolName).toBe('Read');
      expect(result.context).toBe('engineering');
    });
  });

  describe('constants', () => {
    it('has sensible defaults', () => {
      expect(_MIN_SHARE_SUCCESS_RATE).toBeGreaterThan(0);
      expect(_MIN_USAGE_COUNT).toBeGreaterThan(0);
      expect(_MAX_BATCH_SIZE).toBeGreaterThan(0);
    });

    it('PII_KEYS includes critical fields', () => {
      expect(_PII_KEYS.has('user')).toBe(true);
      expect(_PII_KEYS.has('email')).toBe(true);
      expect(_PII_KEYS.has('hostname')).toBe(true);
    });
  });
});
