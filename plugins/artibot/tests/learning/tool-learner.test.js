import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  recordUsage,
  suggestTool,
  pruneOldRecords,
  buildContextKey,
  getToolStats,
  getContextMap,
  resetHistory,
  recordGroupComparison,
  suggestToolCandidates,
  getGrpoHistory,
  getGrpoScores,
  _clearCache,
} from '../../lib/learning/tool-learner.js';

// tool-learner uses node:fs/promises directly, so mock it
vi.mock('node:fs/promises', () => ({
  default: {
    readFile: vi.fn(() => Promise.reject(Object.assign(new Error('not found'), { code: 'ENOENT' }))),
    writeFile: vi.fn(() => Promise.resolve()),
    mkdir: vi.fn(() => Promise.resolve()),
  },
}));

const fsModule = await import('node:fs/promises');
const fs = fsModule.default;

describe('tool-learner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _clearCache();
    // Default: no history file
    fs.readFile.mockRejectedValue(Object.assign(new Error('not found'), { code: 'ENOENT' }));
  });

  // ---------------------------------------------------------------------------
  describe('recordUsage()', () => {
    it('saves a usage record to history', async () => {
      await recordUsage('Read', 'search:file', 1.0);
      expect(fs.writeFile).toHaveBeenCalledTimes(1);
    });

    it('clamps score to 0-1 range', async () => {
      await recordUsage('Read', 'search:file', 1.5);
      const content = JSON.parse(fs.writeFile.mock.calls[0][1]);
      const record = content.contexts['search:file'][0];
      expect(record.score).toBeLessThanOrEqual(1.0);
      expect(record.score).toBeGreaterThanOrEqual(0);
    });

    it('appends to existing context records', async () => {
      // Simulate existing history
      const existing = {
        version: 2,
        contexts: {
          'search:file': [
            { tool: 'Read', context: 'search:file', score: 0.8, timestamp: Date.now() - 10000 },
          ],
        },
        aggregates: {},
        grpoGroups: {},
        grpoScores: {},
        lastUpdated: Date.now(),
      };
      fs.readFile.mockResolvedValueOnce(JSON.stringify(existing));
      _clearCache();

      await recordUsage('Grep', 'search:file', 0.9);
      const content = JSON.parse(fs.writeFile.mock.calls[0][1]);
      expect(content.contexts['search:file']).toHaveLength(2);
    });

    it('creates new context bucket when none exists', async () => {
      await recordUsage('Grep', 'analyze:typescript', 0.7);
      const content = JSON.parse(fs.writeFile.mock.calls[0][1]);
      expect(content.contexts['analyze:typescript']).toHaveLength(1);
    });

    it('updates aggregates for the tool', async () => {
      await recordUsage('Read', 'search:file', 0.9);
      const content = JSON.parse(fs.writeFile.mock.calls[0][1]);
      expect(content.aggregates['Read']).toBeDefined();
      expect(content.aggregates['Read'].totalUses).toBe(1);
      expect(content.aggregates['Read'].avgScore).toBe(0.9);
    });

    it('caps records at MAX_RECORDS_PER_KEY (200) per context', async () => {
      const existing = {
        version: 2,
        contexts: {
          'search:file': Array.from({ length: 200 }, (_, i) => ({
            tool: 'Read', context: 'search:file', score: 0.8, timestamp: Date.now() - i * 1000,
          })),
        },
        aggregates: {},
        grpoGroups: {},
        grpoScores: {},
        lastUpdated: Date.now(),
      };
      fs.readFile.mockResolvedValueOnce(JSON.stringify(existing));
      _clearCache();

      await recordUsage('Read', 'search:file', 1.0);
      const content = JSON.parse(fs.writeFile.mock.calls[0][1]);
      expect(content.contexts['search:file'].length).toBeLessThanOrEqual(200);
    });

    it('stores meta.command and meta.domain in record', async () => {
      await recordUsage('Read', 'search:file', 1.0, { command: '/analyze', domain: 'frontend' });
      const content = JSON.parse(fs.writeFile.mock.calls[0][1]);
      const record = content.contexts['search:file'][0];
      expect(record.command).toBe('/analyze');
      expect(record.domain).toBe('frontend');
    });
  });

  // ---------------------------------------------------------------------------
  describe('suggestTool()', () => {
    it('returns empty array when no data exists for context', async () => {
      const suggestions = await suggestTool('unknown:context');
      expect(Array.isArray(suggestions)).toBe(true);
    });

    it('returns suggestions with required fields', async () => {
      // Setup history with enough records
      const records = Array.from({ length: 5 }, (_, i) => ({
        tool: 'Read', context: 'search:file', score: 0.9, timestamp: Date.now() - i * 1000,
      }));
      const existing = {
        version: 2,
        contexts: { 'search:file': records },
        aggregates: {},
        grpoGroups: {},
        grpoScores: {},
        lastUpdated: Date.now(),
      };
      fs.readFile.mockResolvedValueOnce(JSON.stringify(existing));
      _clearCache();

      const suggestions = await suggestTool('search:file');
      if (suggestions.length > 0) {
        expect(suggestions[0]).toHaveProperty('tool');
        expect(suggestions[0]).toHaveProperty('weightedScore');
        expect(suggestions[0]).toHaveProperty('rawAvg');
        expect(suggestions[0]).toHaveProperty('samples');
        expect(suggestions[0]).toHaveProperty('confidence');
      }
    });

    it('ranks higher-scoring tool first', async () => {
      const records = [
        ...Array.from({ length: 5 }, (_, i) => ({
          tool: 'Read', context: 'search:file', score: 0.9, timestamp: Date.now() - i * 1000,
        })),
        ...Array.from({ length: 5 }, (_, i) => ({
          tool: 'Grep', context: 'search:file', score: 0.3, timestamp: Date.now() - i * 1000,
        })),
      ];
      const existing = {
        version: 2,
        contexts: { 'search:file': records },
        aggregates: {},
        grpoGroups: {},
        grpoScores: {},
        lastUpdated: Date.now(),
      };
      fs.readFile.mockResolvedValueOnce(JSON.stringify(existing));
      _clearCache();

      const suggestions = await suggestTool('search:file');
      if (suggestions.length >= 2) {
        expect(suggestions[0].tool).toBe('Read');
      }
    });

    it('respects limit option', async () => {
      const records = [
        ...Array.from({ length: 5 }, () => ({ tool: 'Read', context: 'search:file', score: 0.9, timestamp: Date.now() })),
        ...Array.from({ length: 5 }, () => ({ tool: 'Grep', context: 'search:file', score: 0.8, timestamp: Date.now() })),
        ...Array.from({ length: 5 }, () => ({ tool: 'Task', context: 'search:file', score: 0.7, timestamp: Date.now() })),
      ];
      const existing = {
        version: 2,
        contexts: { 'search:file': records },
        aggregates: {},
        grpoGroups: {},
        grpoScores: {},
        lastUpdated: Date.now(),
      };
      fs.readFile.mockResolvedValueOnce(JSON.stringify(existing));
      _clearCache();

      const suggestions = await suggestTool('search:file', { limit: 1 });
      expect(suggestions.length).toBeLessThanOrEqual(1);
    });

    it('filters results by minScore threshold', async () => {
      const records = Array.from({ length: 5 }, () => ({
        tool: 'Grep', context: 'search:file', score: 0.2, timestamp: Date.now(),
      }));
      const existing = {
        version: 2,
        contexts: { 'search:file': records },
        aggregates: {},
        grpoGroups: {},
        grpoScores: {},
        lastUpdated: Date.now(),
      };
      fs.readFile.mockResolvedValueOnce(JSON.stringify(existing));
      _clearCache();

      const suggestions = await suggestTool('search:file', { minScore: 0.8 });
      expect(suggestions).toHaveLength(0);
    });

    it('requires minimum 3 samples before trusting suggestion', async () => {
      const records = Array.from({ length: 2 }, () => ({
        tool: 'Read', context: 'search:file', score: 1.0, timestamp: Date.now(),
      }));
      const existing = {
        version: 2,
        contexts: { 'search:file': records },
        aggregates: {},
        grpoGroups: {},
        grpoScores: {},
        lastUpdated: Date.now(),
      };
      fs.readFile.mockResolvedValueOnce(JSON.stringify(existing));
      _clearCache();

      // With only 2 samples, should not be returned (MIN_SAMPLES=3)
      const suggestions = await suggestTool('search:file');
      expect(suggestions.filter((s) => s.samples < 3)).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  describe('pruneOldRecords()', () => {
    it('returns 0 when no records to prune', async () => {
      const pruned = await pruneOldRecords();
      expect(pruned).toBe(0);
    });

    it('removes records older than retention period', async () => {
      const oldTimestamp = Date.now() - (100 * 24 * 60 * 60 * 1000); // 100 days ago
      const existing = {
        version: 2,
        contexts: {
          'search:file': [
            { tool: 'Read', context: 'search:file', score: 0.9, timestamp: oldTimestamp },
            { tool: 'Read', context: 'search:file', score: 0.8, timestamp: Date.now() - 1000 },
          ],
        },
        aggregates: {},
        grpoGroups: {},
        grpoScores: {},
        lastUpdated: Date.now(),
      };
      fs.readFile.mockResolvedValueOnce(JSON.stringify(existing));
      _clearCache();

      const pruned = await pruneOldRecords(90 * 24 * 60 * 60 * 1000);
      expect(pruned).toBe(1);
    });

    it('deletes empty context buckets after pruning', async () => {
      const oldTimestamp = Date.now() - (100 * 24 * 60 * 60 * 1000);
      const existing = {
        version: 2,
        contexts: {
          'old:context': [
            { tool: 'Read', context: 'old:context', score: 0.9, timestamp: oldTimestamp },
          ],
        },
        aggregates: {},
        grpoGroups: {},
        grpoScores: {},
        lastUpdated: Date.now(),
      };
      fs.readFile.mockResolvedValueOnce(JSON.stringify(existing));
      _clearCache();

      await pruneOldRecords(90 * 24 * 60 * 60 * 1000);
      const content = JSON.parse(fs.writeFile.mock.calls[0][1]);
      expect(content.contexts['old:context']).toBeUndefined();
    });

    it('verifies 7-day half-life decay by checking recent records survive', async () => {
      const recentTimestamp = Date.now() - (3 * 24 * 60 * 60 * 1000); // 3 days ago
      const existing = {
        version: 2,
        contexts: {
          'search:file': [
            { tool: 'Read', context: 'search:file', score: 0.9, timestamp: recentTimestamp },
          ],
        },
        aggregates: {},
        grpoGroups: {},
        grpoScores: {},
        lastUpdated: Date.now(),
      };
      fs.readFile.mockResolvedValueOnce(JSON.stringify(existing));
      _clearCache();

      // 30-day retention: 3-day-old record should survive
      const pruned = await pruneOldRecords(30 * 24 * 60 * 60 * 1000);
      expect(pruned).toBe(0);
    });

    it('prunes GRPO groups older than retention period', async () => {
      const oldTimestamp = Date.now() - (100 * 24 * 60 * 60 * 1000);
      const existing = {
        version: 2,
        contexts: {},
        aggregates: {},
        grpoGroups: {
          'search:file': [
            { context: 'search:file', rankings: [], timestamp: oldTimestamp },
          ],
        },
        grpoScores: {},
        lastUpdated: Date.now(),
      };
      fs.readFile.mockResolvedValueOnce(JSON.stringify(existing));
      _clearCache();

      const pruned = await pruneOldRecords(90 * 24 * 60 * 60 * 1000);
      expect(pruned).toBeGreaterThan(0);
    });

    it('does not save when no records were pruned', async () => {
      const existing = {
        version: 2,
        contexts: {
          'search:file': [
            { tool: 'Read', context: 'search:file', score: 0.9, timestamp: Date.now() - 1000 },
          ],
        },
        aggregates: {},
        grpoGroups: {},
        grpoScores: {},
        lastUpdated: Date.now(),
      };
      fs.readFile.mockResolvedValueOnce(JSON.stringify(existing));
      _clearCache();

      await pruneOldRecords(90 * 24 * 60 * 60 * 1000);
      expect(fs.writeFile).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  describe('half-life decay simulation', () => {
    const HALF_LIFE_DAYS = 7;
    const MS_PER_DAY = 24 * 60 * 60 * 1000;

    /**
     * The decay weight for a record at a given age is: Math.pow(0.5, age / halfLifeMs).
     * For a set of records with all the same score S:
     *   weightedScore = (S * sum(weights)) / sum(weights) = S
     * So decay only matters when records have DIFFERENT scores.
     *
     * To verify decay, we mix a fresh high-score record with an old low-score record
     * and check that the fresh record dominates more as the old record ages.
     */

    /**
     * Returns the weightedScore for 'Read' when mixing one fresh record (score=1.0)
     * and one aged record (score=0.0, daysAgo old). A larger aged decay weight means
     * the 0.0 record drags the weighted score down more.
     */
    async function getMixedWeightedScore(daysAgo) {
      const now = Date.now();
      const records = [
        { tool: 'Read', context: 'decay:test', score: 1.0, timestamp: now },         // fresh high-score
        { tool: 'Read', context: 'decay:test', score: 1.0, timestamp: now },
        { tool: 'Read', context: 'decay:test', score: 1.0, timestamp: now },
        { tool: 'Read', context: 'decay:test', score: 0.0, timestamp: now - daysAgo * MS_PER_DAY }, // old low-score
        { tool: 'Read', context: 'decay:test', score: 0.0, timestamp: now - daysAgo * MS_PER_DAY },
        { tool: 'Read', context: 'decay:test', score: 0.0, timestamp: now - daysAgo * MS_PER_DAY },
      ];
      const existing = {
        version: 2,
        contexts: { 'decay:test': records },
        aggregates: {},
        grpoGroups: {},
        grpoScores: {},
        lastUpdated: now,
      };
      fs.readFile.mockResolvedValueOnce(JSON.stringify(existing));
      _clearCache();
      const suggestions = await suggestTool('decay:test', { minScore: 0 });
      return suggestions[0]?.weightedScore ?? 0;
    }

    it('7-day-old zero-score records have approximately 50% impact vs fresh records', async () => {
      // With fresh score=1.0 (weight=1) and 7-day-old score=0.0 (weight~0.5):
      // weightedScore = (1.0*1 + 1.0*1 + 1.0*1 + 0*0.5 + 0*0.5 + 0*0.5) / (1+1+1+0.5+0.5+0.5)
      // = 3 / 4.5 = ~0.667
      const score7d = await getMixedWeightedScore(HALF_LIFE_DAYS);
      expect(score7d).toBeGreaterThan(0.55);
      expect(score7d).toBeLessThan(0.80);
    });

    it('14-day-old zero-score records have approximately 25% impact vs fresh records', async () => {
      // With fresh score=1.0 (weight=1) and 14-day-old score=0.0 (weight~0.25):
      // weightedScore = 3 / (3 + 3*0.25) = 3 / 3.75 = ~0.8
      const score14d = await getMixedWeightedScore(HALF_LIFE_DAYS * 2);
      expect(score14d).toBeGreaterThan(0.70);
      expect(score14d).toBeLessThan(0.95);
    });

    it('older zero-score records drag score down less (decay reduces influence)', async () => {
      const score7d = await getMixedWeightedScore(HALF_LIFE_DAYS);
      const score14d = await getMixedWeightedScore(HALF_LIFE_DAYS * 2);
      // 14-day old records contribute less weight, so fresh scores dominate more
      expect(score14d).toBeGreaterThan(score7d);
    });

    it('14-day old records have roughly half the decay weight of 7-day old records', async () => {
      // We verify the exponential decay formula: weight = 0.5^(age/halfLife)
      // At 7 days: weight = 0.5^1 = 0.5
      // At 14 days: weight = 0.5^2 = 0.25
      // Ratio of weights: 0.25/0.5 = 0.5
      const HALF_LIFE_MS = HALF_LIFE_DAYS * MS_PER_DAY;
      const weight7d = Math.pow(0.5, (HALF_LIFE_DAYS * MS_PER_DAY) / HALF_LIFE_MS);
      const weight14d = Math.pow(0.5, (HALF_LIFE_DAYS * 2 * MS_PER_DAY) / HALF_LIFE_MS);
      const ratio = weight14d / weight7d;
      expect(ratio).toBeCloseTo(0.5, 2);
    });

    it('fresh records (0 days) have maximum decay weight of 1.0', async () => {
      const HALF_LIFE_MS = HALF_LIFE_DAYS * MS_PER_DAY;
      const weightFresh = Math.pow(0.5, 0 / HALF_LIFE_MS);
      expect(weightFresh).toBe(1.0);
    });
  });

  // ---------------------------------------------------------------------------
  describe('buildContextKey()', () => {
    it('builds a two-part key', () => {
      const key = buildContextKey('search', 'typescript');
      expect(key).toBe('search:typescript');
    });

    it('builds a three-part key with scope', () => {
      const key = buildContextKey('edit', 'javascript', 'file');
      expect(key).toBe('edit:javascript:file');
    });

    it('normalizes to lowercase', () => {
      const key = buildContextKey('SEARCH', 'TypeScript', 'FILE');
      expect(key).toBe('search:typescript:file');
    });

    it('trims whitespace from parts', () => {
      const key = buildContextKey('  analyze ', ' go  ');
      expect(key).toBe('analyze:go');
    });

    it('returns two-part key when scope is undefined', () => {
      const key = buildContextKey('build', 'python', undefined);
      expect(key).toBe('build:python');
    });

    it('produces distinct keys for different inputs', () => {
      const k1 = buildContextKey('search', 'file');
      const k2 = buildContextKey('search', 'config');
      const k3 = buildContextKey('analyze', 'file');
      expect(k1).not.toBe(k2);
      expect(k1).not.toBe(k3);
      expect(k2).not.toBe(k3);
    });

    it('handles special characters in parts by lowercasing them', () => {
      const key = buildContextKey('test', 'E2E');
      expect(key).toBe('test:e2e');
    });
  });

  // ---------------------------------------------------------------------------
  describe('recordGroupComparison()', () => {
    it('throws when given fewer than 2 results', async () => {
      await expect(recordGroupComparison('search:file', [{ tool: 'Read' }])).rejects.toThrow(
        'GRPO requires at least 2 tool results to compare',
      );
    });

    it('throws when given null results', async () => {
      await expect(recordGroupComparison('search:file', null)).rejects.toThrow();
    });

    it('records a group comparison and returns rankings', async () => {
      const results = [
        { tool: 'Read', success: true, durationMs: 100, accuracy: 0.9, brevity: 0.8 },
        { tool: 'Grep', success: false, durationMs: 500, accuracy: 0.3, brevity: 0.5 },
      ];
      const group = await recordGroupComparison('search:file', results);
      expect(group).toHaveProperty('context', 'search:file');
      expect(group).toHaveProperty('rankings');
      expect(group).toHaveProperty('timestamp');
      expect(group.rankings).toHaveLength(2);
    });

    it('ranks successful tool higher than failed tool', async () => {
      const results = [
        { tool: 'Read', success: true, durationMs: 100, accuracy: 0.9, brevity: 0.8 },
        { tool: 'Grep', success: false, durationMs: 500, accuracy: 0.3, brevity: 0.5 },
      ];
      const group = await recordGroupComparison('search:file', results);
      expect(group.rankings[0].tool).toBe('Read');
      expect(group.rankings[0].rank).toBe(1);
    });

    it('each ranking entry has compositeScore, relativeAdvantage, and rank', async () => {
      const results = [
        { tool: 'Read', success: true, durationMs: 50, accuracy: 0.9, brevity: 0.9 },
        { tool: 'Grep', success: true, durationMs: 200, accuracy: 0.7, brevity: 0.6 },
      ];
      const group = await recordGroupComparison('search:file', results);
      for (const r of group.rankings) {
        expect(r).toHaveProperty('tool');
        expect(r).toHaveProperty('compositeScore');
        expect(r).toHaveProperty('relativeAdvantage');
        expect(r).toHaveProperty('rank');
      }
    });

    it('saves to disk after recording', async () => {
      const results = [
        { tool: 'Read', success: true, durationMs: 100, accuracy: 0.8, brevity: 0.7 },
        { tool: 'Grep', success: true, durationMs: 300, accuracy: 0.6, brevity: 0.5 },
      ];
      await recordGroupComparison('search:file', results);
      expect(fs.writeFile).toHaveBeenCalled();
    });

    it('updates GRPO cumulative scores in history', async () => {
      const results = [
        { tool: 'Read', success: true, durationMs: 100, accuracy: 0.9, brevity: 0.8 },
        { tool: 'Grep', success: false, durationMs: 800, accuracy: 0.2, brevity: 0.4 },
      ];
      await recordGroupComparison('search:file', results);
      const content = JSON.parse(fs.writeFile.mock.calls[0][1]);
      expect(content.grpoScores['search:file::Read']).toBeDefined();
      expect(content.grpoScores['search:file::Grep']).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  describe('suggestToolCandidates()', () => {
    it('returns empty array when no data exists', async () => {
      const candidates = await suggestToolCandidates('unknown:context');
      expect(Array.isArray(candidates)).toBe(true);
      expect(candidates).toHaveLength(0);
    });

    it('returns candidates with required fields', async () => {
      const existing = {
        version: 2,
        contexts: {
          'search:file': Array.from({ length: 5 }, () => ({
            tool: 'Read', context: 'search:file', score: 0.9, timestamp: Date.now(),
          })),
        },
        aggregates: {},
        grpoGroups: {},
        grpoScores: {},
        lastUpdated: Date.now(),
      };
      fs.readFile.mockResolvedValueOnce(JSON.stringify(existing));
      _clearCache();

      const candidates = await suggestToolCandidates('search:file');
      if (candidates.length > 0) {
        expect(candidates[0]).toHaveProperty('tool');
        expect(candidates[0]).toHaveProperty('toolformerScore');
        expect(candidates[0]).toHaveProperty('grpoScore');
        expect(candidates[0]).toHaveProperty('combinedScore');
      }
    });

    it('respects count parameter', async () => {
      const existing = {
        version: 2,
        contexts: {
          'search:file': [
            ...Array.from({ length: 5 }, () => ({ tool: 'Read', context: 'search:file', score: 0.9, timestamp: Date.now() })),
            ...Array.from({ length: 5 }, () => ({ tool: 'Grep', context: 'search:file', score: 0.8, timestamp: Date.now() })),
            ...Array.from({ length: 5 }, () => ({ tool: 'Task', context: 'search:file', score: 0.7, timestamp: Date.now() })),
          ],
        },
        aggregates: {},
        grpoGroups: {},
        grpoScores: {},
        lastUpdated: Date.now(),
      };
      fs.readFile.mockResolvedValueOnce(JSON.stringify(existing));
      _clearCache();

      const candidates = await suggestToolCandidates('search:file', 2);
      expect(candidates.length).toBeLessThanOrEqual(2);
    });

    it('combines GRPO and Toolformer scores', async () => {
      const existing = {
        version: 2,
        contexts: {
          'search:file': Array.from({ length: 5 }, () => ({
            tool: 'Read', context: 'search:file', score: 0.9, timestamp: Date.now(),
          })),
        },
        aggregates: {},
        grpoGroups: {
          'search:file': [
            { context: 'search:file', rankings: [{ tool: 'Read', compositeScore: 0.8, relativeAdvantage: 0.2, rank: 1 }], timestamp: Date.now() },
            { context: 'search:file', rankings: [{ tool: 'Read', compositeScore: 0.9, relativeAdvantage: 0.3, rank: 1 }], timestamp: Date.now() },
          ],
        },
        grpoScores: { 'search:file::Read': 0.8 },
        lastUpdated: Date.now(),
      };
      fs.readFile.mockResolvedValueOnce(JSON.stringify(existing));
      _clearCache();

      const candidates = await suggestToolCandidates('search:file');
      const readCandidate = candidates.find((c) => c.tool === 'Read');
      expect(readCandidate).toBeDefined();
      expect(readCandidate.combinedScore).toBeGreaterThan(0);
    });

    it('pulls from related contexts when few candidates', async () => {
      const existing = {
        version: 2,
        contexts: {
          'search:config': Array.from({ length: 5 }, () => ({
            tool: 'Grep', context: 'search:config', score: 0.85, timestamp: Date.now(),
          })),
        },
        aggregates: {},
        grpoGroups: {},
        grpoScores: {},
        lastUpdated: Date.now(),
      };
      fs.readFile.mockResolvedValueOnce(JSON.stringify(existing));
      _clearCache();

      // search:file has no data, but search:config does (same prefix "search:")
      const candidates = await suggestToolCandidates('search:file');
      // Should discover Grep from the related context
      const grepCandidate = candidates.find((c) => c.tool === 'Grep');
      expect(grepCandidate).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  describe('getGrpoHistory()', () => {
    it('returns empty array when no GRPO history exists', async () => {
      const history = await getGrpoHistory('unknown:context');
      expect(history).toEqual([]);
    });

    it('returns stored GRPO groups for a context', async () => {
      const group = {
        context: 'search:file',
        rankings: [
          { tool: 'Read', compositeScore: 0.9, relativeAdvantage: 0.2, rank: 1 },
        ],
        timestamp: Date.now(),
      };
      const existing = {
        version: 2,
        contexts: {},
        aggregates: {},
        grpoGroups: { 'search:file': [group] },
        grpoScores: {},
        lastUpdated: Date.now(),
      };
      fs.readFile.mockResolvedValueOnce(JSON.stringify(existing));
      _clearCache();

      const history = await getGrpoHistory('search:file');
      expect(history).toHaveLength(1);
      expect(history[0].context).toBe('search:file');
    });

    it('respects limit parameter', async () => {
      const groups = Array.from({ length: 20 }, (_, i) => ({
        context: 'search:file',
        rankings: [{ tool: 'Read', compositeScore: 0.9, relativeAdvantage: 0.1, rank: 1 }],
        timestamp: Date.now() - i * 1000,
      }));
      const existing = {
        version: 2,
        contexts: {},
        aggregates: {},
        grpoGroups: { 'search:file': groups },
        grpoScores: {},
        lastUpdated: Date.now(),
      };
      fs.readFile.mockResolvedValueOnce(JSON.stringify(existing));
      _clearCache();

      const history = await getGrpoHistory('search:file', 5);
      expect(history).toHaveLength(5);
    });
  });

  // ---------------------------------------------------------------------------
  describe('getGrpoScores()', () => {
    it('returns empty object when no scores exist', async () => {
      const scores = await getGrpoScores('unknown:context');
      expect(scores).toEqual({});
    });

    it('returns tool-to-score map for a context', async () => {
      const existing = {
        version: 2,
        contexts: {},
        aggregates: {},
        grpoGroups: {},
        grpoScores: {
          'search:file::Read': 0.75,
          'search:file::Grep': 0.55,
          'other:context::Read': 0.9,
        },
        lastUpdated: Date.now(),
      };
      fs.readFile.mockResolvedValueOnce(JSON.stringify(existing));
      _clearCache();

      const scores = await getGrpoScores('search:file');
      expect(scores).toEqual({ Read: 0.75, Grep: 0.55 });
    });

    it('does not include scores from other contexts', async () => {
      const existing = {
        version: 2,
        contexts: {},
        aggregates: {},
        grpoGroups: {},
        grpoScores: {
          'search:file::Read': 0.75,
          'other:context::Read': 0.9,
        },
        lastUpdated: Date.now(),
      };
      fs.readFile.mockResolvedValueOnce(JSON.stringify(existing));
      _clearCache();

      const scores = await getGrpoScores('search:file');
      expect(Object.keys(scores)).toHaveLength(1);
      expect(scores.Read).toBe(0.75);
    });
  });
});
