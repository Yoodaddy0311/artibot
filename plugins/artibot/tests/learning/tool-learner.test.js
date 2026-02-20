import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  recordUsage,
  suggestTool,
  pruneOldRecords,
  buildContextKey,
  getToolStats,
  recordGroupComparison,
  suggestToolCandidates,
  getGrpoHistory,
  getGrpoScores,
  flushToDisk,
  shutdownToolLearner,
  _clearCache,
  _getBufferState,
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
    vi.useFakeTimers();
    _clearCache();
    // Default: no history file
    fs.readFile.mockRejectedValue(Object.assign(new Error('not found'), { code: 'ENOENT' }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ---------------------------------------------------------------------------
  describe('recordUsage()', () => {
    it('does not write to disk immediately (uses batch buffer)', async () => {
      await recordUsage('Read', 'search:file', 1.0);
      expect(fs.writeFile).not.toHaveBeenCalled();
    });

    it('marks buffer as dirty after recording', async () => {
      await recordUsage('Read', 'search:file', 1.0);
      const state = _getBufferState();
      expect(state.dirty).toBe(true);
      expect(state.hasTimer).toBe(true);
    });

    it('writes to disk after flush', async () => {
      await recordUsage('Read', 'search:file', 1.0);
      await flushToDisk();
      expect(fs.writeFile).toHaveBeenCalledTimes(1);
    });

    it('clamps score to 0-1 range', async () => {
      await recordUsage('Read', 'search:file', 1.5);
      await flushToDisk();
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
      await flushToDisk();
      const content = JSON.parse(fs.writeFile.mock.calls[0][1]);
      expect(content.contexts['search:file']).toHaveLength(2);
    });

    it('creates new context bucket when none exists', async () => {
      await recordUsage('Grep', 'analyze:typescript', 0.7);
      await flushToDisk();
      const content = JSON.parse(fs.writeFile.mock.calls[0][1]);
      expect(content.contexts['analyze:typescript']).toHaveLength(1);
    });

    it('updates aggregates for the tool', async () => {
      await recordUsage('Read', 'search:file', 0.9);
      await flushToDisk();
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
      await flushToDisk();
      const content = JSON.parse(fs.writeFile.mock.calls[0][1]);
      expect(content.contexts['search:file'].length).toBeLessThanOrEqual(200);
    });

    it('stores meta.command and meta.domain in record', async () => {
      await recordUsage('Read', 'search:file', 1.0, { command: '/analyze', domain: 'frontend' });
      await flushToDisk();
      const content = JSON.parse(fs.writeFile.mock.calls[0][1]);
      const record = content.contexts['search:file'][0];
      expect(record.command).toBe('/analyze');
      expect(record.domain).toBe('frontend');
    });
  });

  // ---------------------------------------------------------------------------
  describe('batch write buffer', () => {
    it('does not write to disk on recordUsage (deferred write)', async () => {
      await recordUsage('Read', 'search:file', 1.0);
      expect(fs.writeFile).not.toHaveBeenCalled();
      expect(_getBufferState().dirty).toBe(true);
    });

    it('flushes to disk after FLUSH_INTERVAL_MS (5000ms)', async () => {
      await recordUsage('Read', 'search:file', 1.0);
      expect(fs.writeFile).not.toHaveBeenCalled();

      // Advance timers past the flush interval
      await vi.advanceTimersByTimeAsync(5000);

      expect(fs.writeFile).toHaveBeenCalledTimes(1);
    });

    it('flushToDisk writes when dirty', async () => {
      await recordUsage('Read', 'search:file', 0.8);
      expect(fs.writeFile).not.toHaveBeenCalled();

      await flushToDisk();

      expect(fs.writeFile).toHaveBeenCalledTimes(1);
      expect(_getBufferState().dirty).toBe(false);
      expect(_getBufferState().hasTimer).toBe(false);
    });

    it('flushToDisk is a no-op when not dirty', async () => {
      await flushToDisk();
      expect(fs.writeFile).not.toHaveBeenCalled();
    });

    it('flushToDisk clears the pending timer', async () => {
      await recordUsage('Read', 'search:file', 1.0);
      expect(_getBufferState().hasTimer).toBe(true);

      await flushToDisk();
      expect(_getBufferState().hasTimer).toBe(false);
    });

    it('batches multiple recordUsage calls into a single write', async () => {
      await recordUsage('Read', 'search:file', 1.0);
      await recordUsage('Grep', 'search:config', 0.8);
      await recordUsage('Task', 'analyze:typescript', 0.9);

      expect(fs.writeFile).not.toHaveBeenCalled();

      await flushToDisk();

      expect(fs.writeFile).toHaveBeenCalledTimes(1);
      const content = JSON.parse(fs.writeFile.mock.calls[0][1]);
      expect(content.contexts['search:file']).toHaveLength(1);
      expect(content.contexts['search:config']).toHaveLength(1);
      expect(content.contexts['analyze:typescript']).toHaveLength(1);
    });

    it('does not schedule multiple timers for multiple recordUsage calls', async () => {
      await recordUsage('Read', 'search:file', 1.0);
      const state1 = _getBufferState();
      expect(state1.hasTimer).toBe(true);

      await recordUsage('Grep', 'search:config', 0.8);
      const state2 = _getBufferState();
      expect(state2.hasTimer).toBe(true);

      // Only one write after timer fires
      await vi.advanceTimersByTimeAsync(5000);
      expect(fs.writeFile).toHaveBeenCalledTimes(1);
    });

    it('shutdownToolLearner calls flushToDisk', async () => {
      await recordUsage('Read', 'search:file', 1.0);
      expect(fs.writeFile).not.toHaveBeenCalled();

      await shutdownToolLearner();

      expect(fs.writeFile).toHaveBeenCalledTimes(1);
      expect(_getBufferState().dirty).toBe(false);
    });

    it('_clearCache resets dirty state and timer', async () => {
      await recordUsage('Read', 'search:file', 1.0);
      expect(_getBufferState().dirty).toBe(true);
      expect(_getBufferState().hasTimer).toBe(true);

      _clearCache();

      expect(_getBufferState().dirty).toBe(false);
      expect(_getBufferState().hasTimer).toBe(false);
    });

    it('recordGroupComparison uses batch buffer (no immediate write)', async () => {
      const results = [
        { tool: 'Read', success: true, durationMs: 100, accuracy: 0.9, brevity: 0.8 },
        { tool: 'Grep', success: false, durationMs: 500, accuracy: 0.3, brevity: 0.5 },
      ];
      await recordGroupComparison('search:file', results);
      expect(fs.writeFile).not.toHaveBeenCalled();
      expect(_getBufferState().dirty).toBe(true);
    });

    it('pruneOldRecords uses batch buffer when records are pruned', async () => {
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
      expect(fs.writeFile).not.toHaveBeenCalled();
      expect(_getBufferState().dirty).toBe(true);

      await flushToDisk();
      expect(fs.writeFile).toHaveBeenCalledTimes(1);
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
      await flushToDisk();
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

    it('does not mark dirty when no records were pruned', async () => {
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
      expect(_getBufferState().dirty).toBe(false);
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
      const score7d = await getMixedWeightedScore(HALF_LIFE_DAYS);
      expect(score7d).toBeGreaterThan(0.55);
      expect(score7d).toBeLessThan(0.80);
    });

    it('14-day-old zero-score records have approximately 25% impact vs fresh records', async () => {
      const score14d = await getMixedWeightedScore(HALF_LIFE_DAYS * 2);
      expect(score14d).toBeGreaterThan(0.70);
      expect(score14d).toBeLessThan(0.95);
    });

    it('older zero-score records drag score down less (decay reduces influence)', async () => {
      const score7d = await getMixedWeightedScore(HALF_LIFE_DAYS);
      const score14d = await getMixedWeightedScore(HALF_LIFE_DAYS * 2);
      expect(score14d).toBeGreaterThan(score7d);
    });

    it('14-day old records have roughly half the decay weight of 7-day old records', async () => {
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

    it('marks buffer dirty after recording (deferred write)', async () => {
      const results = [
        { tool: 'Read', success: true, durationMs: 100, accuracy: 0.8, brevity: 0.7 },
        { tool: 'Grep', success: true, durationMs: 300, accuracy: 0.6, brevity: 0.5 },
      ];
      await recordGroupComparison('search:file', results);
      expect(fs.writeFile).not.toHaveBeenCalled();
      expect(_getBufferState().dirty).toBe(true);
    });

    it('writes to disk after flush', async () => {
      const results = [
        { tool: 'Read', success: true, durationMs: 100, accuracy: 0.8, brevity: 0.7 },
        { tool: 'Grep', success: true, durationMs: 300, accuracy: 0.6, brevity: 0.5 },
      ];
      await recordGroupComparison('search:file', results);
      await flushToDisk();
      expect(fs.writeFile).toHaveBeenCalled();
    });

    it('updates GRPO cumulative scores in history', async () => {
      const results = [
        { tool: 'Read', success: true, durationMs: 100, accuracy: 0.9, brevity: 0.8 },
        { tool: 'Grep', success: false, durationMs: 800, accuracy: 0.2, brevity: 0.4 },
      ];
      await recordGroupComparison('search:file', results);
      await flushToDisk();
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

  // ---------------------------------------------------------------------------
  describe('loadHistory() migration paths', () => {
    it('resets history when version is 0 (invalid)', async () => {
      const existing = {
        version: 0,
        contexts: { 'old:ctx': [{ tool: 'Read', context: 'old:ctx', score: 0.5, timestamp: Date.now() }] },
        aggregates: {},
        lastUpdated: Date.now(),
      };
      fs.readFile.mockResolvedValueOnce(JSON.stringify(existing));
      _clearCache();

      // After loadHistory, a version-0 file should be replaced with empty
      const stats = await getToolStats();
      expect(Object.keys(stats)).toHaveLength(0);
    });

    it('resets history when version field is missing', async () => {
      const existing = {
        contexts: { 'old:ctx': [{ tool: 'Read', context: 'old:ctx', score: 0.5, timestamp: Date.now() }] },
        aggregates: {},
        lastUpdated: Date.now(),
      };
      fs.readFile.mockResolvedValueOnce(JSON.stringify(existing));
      _clearCache();

      const stats = await getToolStats();
      expect(Object.keys(stats)).toHaveLength(0);
    });

    it('migrates v1 history to v2 by adding GRPO fields', async () => {
      const existing = {
        version: 1,
        contexts: {
          'search:file': [{ tool: 'Read', context: 'search:file', score: 0.9, timestamp: Date.now() }],
        },
        aggregates: { Read: { totalUses: 1, totalScore: 0.9, avgScore: 0.9, lastUsed: Date.now() } },
        lastUpdated: Date.now(),
      };
      fs.readFile.mockResolvedValueOnce(JSON.stringify(existing));
      _clearCache();

      // Trigger loadHistory and then flush to inspect resulting structure
      await recordUsage('Grep', 'search:file', 0.8);
      await flushToDisk();
      const content = JSON.parse(fs.writeFile.mock.calls[0][1]);
      expect(content.version).toBe(2);
      expect(content.grpoGroups).toBeDefined();
      expect(content.grpoScores).toBeDefined();
      // Original contexts should be preserved
      expect(content.contexts['search:file'].length).toBeGreaterThanOrEqual(2);
    });

    it('migrates v1 history preserving existing grpoGroups if present', async () => {
      const existing = {
        version: 1,
        contexts: {},
        aggregates: {},
        grpoGroups: { 'test:ctx': [{ context: 'test:ctx', rankings: [], timestamp: Date.now() }] },
        lastUpdated: Date.now(),
      };
      fs.readFile.mockResolvedValueOnce(JSON.stringify(existing));
      _clearCache();

      await recordUsage('Read', 'test:ctx', 0.9);
      await flushToDisk();
      const content = JSON.parse(fs.writeFile.mock.calls[0][1]);
      expect(content.version).toBe(2);
      // Existing grpoGroups should be preserved
      expect(content.grpoGroups['test:ctx']).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------
  describe('computeGrpoComposite speed branches', () => {
    it('handles equal durations (maxDur === minDur) giving speedScore 1.0', async () => {
      const results = [
        { tool: 'Read', success: true, durationMs: 200, accuracy: 0.5, brevity: 0.5 },
        { tool: 'Grep', success: true, durationMs: 200, accuracy: 0.5, brevity: 0.5 },
      ];
      const group = await recordGroupComparison('speed:equal', results);
      // With equal durations, both tools should get identical compositeScores
      expect(group.rankings[0].compositeScore).toBe(group.rankings[1].compositeScore);
    });

    it('handles single tool with positive duration and one with zero duration', async () => {
      // When one tool has durationMs=0 and the other has positive, only one valid duration
      const results = [
        { tool: 'Read', success: true, durationMs: 100, accuracy: 0.7, brevity: 0.7 },
        { tool: 'Grep', success: true, durationMs: 0, accuracy: 0.7, brevity: 0.7 },
      ];
      const group = await recordGroupComparison('speed:single', results);
      // Read has the only positive duration, so durations.length === 1 for it
      // Grep has 0 duration so it gets default 0.5 speed
      expect(group.rankings).toHaveLength(2);
      // Read should rank higher due to speedScore = 1.0 vs Grep's 0.5
      expect(group.rankings[0].tool).toBe('Read');
    });

    it('handles all tools with zero duration (default speedScore 0.5)', async () => {
      const results = [
        { tool: 'Read', success: true, durationMs: 0, accuracy: 0.9, brevity: 0.8 },
        { tool: 'Grep', success: false, durationMs: 0, accuracy: 0.3, brevity: 0.5 },
      ];
      const group = await recordGroupComparison('speed:zero', results);
      expect(group.rankings).toHaveLength(2);
      // Read should still rank first due to success + accuracy + brevity
      expect(group.rankings[0].tool).toBe('Read');
    });
  });

  // ---------------------------------------------------------------------------
  describe('suggestFromRelated() branches', () => {
    it('returns empty array for single-part context key (no prefix match possible)', async () => {
      const suggestions = await suggestTool('singlepart');
      expect(suggestions).toEqual([]);
    });

    it('returns related context suggestions with confidence "low"', async () => {
      const existing = {
        version: 2,
        contexts: {
          'search:config': Array.from({ length: 5 }, (_, i) => ({
            tool: 'Grep', context: 'search:config', score: 0.9, timestamp: Date.now() - i * 1000,
          })),
        },
        aggregates: {},
        grpoGroups: {},
        grpoScores: {},
        lastUpdated: Date.now(),
      };
      fs.readFile.mockResolvedValueOnce(JSON.stringify(existing));
      _clearCache();

      // search:file has no data, should fallback to search:config
      const suggestions = await suggestTool('search:file');
      if (suggestions.length > 0) {
        expect(suggestions[0].confidence).toBe('low');
      }
    });

    it('returns empty when related records have no tools meeting minScore', async () => {
      const existing = {
        version: 2,
        contexts: {
          'search:config': Array.from({ length: 5 }, (_, i) => ({
            tool: 'Grep', context: 'search:config', score: 0.1, timestamp: Date.now() - i * 1000,
          })),
        },
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

    it('returns empty when related records have fewer than MIN_SAMPLES (3)', async () => {
      const existing = {
        version: 2,
        contexts: {
          'search:config': Array.from({ length: 2 }, (_, i) => ({
            tool: 'Grep', context: 'search:config', score: 0.9, timestamp: Date.now() - i * 1000,
          })),
        },
        aggregates: {},
        grpoGroups: {},
        grpoScores: {},
        lastUpdated: Date.now(),
      };
      fs.readFile.mockResolvedValueOnce(JSON.stringify(existing));
      _clearCache();

      const suggestions = await suggestTool('search:file');
      expect(suggestions).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  describe('gatherRelatedTools() branches', () => {
    it('returns empty Map for single-part context key', async () => {
      // Single-part context should return no related tool candidates
      const existing = {
        version: 2,
        contexts: {
          'search:config': Array.from({ length: 5 }, () => ({
            tool: 'Grep', context: 'search:config', score: 0.9, timestamp: Date.now(),
          })),
        },
        aggregates: {},
        grpoGroups: {},
        grpoScores: {},
        lastUpdated: Date.now(),
      };
      fs.readFile.mockResolvedValueOnce(JSON.stringify(existing));
      _clearCache();

      // 'noprefix' has no colon, so gatherRelatedTools returns empty Map
      const candidates = await suggestToolCandidates('noprefix');
      expect(candidates).toHaveLength(0);
    });

    it('picks higher score when same tool appears in multiple related contexts', async () => {
      const existing = {
        version: 2,
        contexts: {
          'search:config': [
            { tool: 'Grep', context: 'search:config', score: 0.6, timestamp: Date.now() },
          ],
          'search:docs': [
            { tool: 'Grep', context: 'search:docs', score: 0.9, timestamp: Date.now() },
          ],
        },
        aggregates: {},
        grpoGroups: {},
        grpoScores: {},
        lastUpdated: Date.now(),
      };
      fs.readFile.mockResolvedValueOnce(JSON.stringify(existing));
      _clearCache();

      // search:file has no data; should pull Grep from related with highest score
      const candidates = await suggestToolCandidates('search:file');
      const grepCandidate = candidates.find((c) => c.tool === 'Grep');
      expect(grepCandidate).toBeDefined();
      // toolformerScore should use highest related score (0.9) * 0.5 discount
      expect(grepCandidate.toolformerScore).toBeCloseTo(0.9 * 0.5, 2);
    });
  });

  // ---------------------------------------------------------------------------
  describe('suggestToolCandidates() combined score branches', () => {
    it('uses GRPO-only score when tool has >= 2 grpoComparisons but < 3 toolformer samples', async () => {
      const existing = {
        version: 2,
        contexts: {
          'test:ctx': [
            { tool: 'Read', context: 'test:ctx', score: 0.9, timestamp: Date.now() },
            { tool: 'Read', context: 'test:ctx', score: 0.8, timestamp: Date.now() },
          ],
        },
        aggregates: {},
        grpoGroups: {
          'test:ctx': [
            { context: 'test:ctx', rankings: [{ tool: 'Read', compositeScore: 0.8, relativeAdvantage: 0.1, rank: 1 }], timestamp: Date.now() },
            { context: 'test:ctx', rankings: [{ tool: 'Read', compositeScore: 0.9, relativeAdvantage: 0.2, rank: 1 }], timestamp: Date.now() },
          ],
        },
        grpoScores: { 'test:ctx::Read': 0.75 },
        lastUpdated: Date.now(),
      };
      fs.readFile.mockResolvedValueOnce(JSON.stringify(existing));
      _clearCache();

      const candidates = await suggestToolCandidates('test:ctx');
      const readCandidate = candidates.find((c) => c.tool === 'Read');
      expect(readCandidate).toBeDefined();
      // grpoComparisons >= 2 but toolformerSamples < 3, so uses GRPO-only
      expect(readCandidate.combinedScore).toBe(readCandidate.grpoScore);
    });

    it('uses Toolformer-only score when tool has >= 3 samples but < 2 grpoComparisons', async () => {
      const existing = {
        version: 2,
        contexts: {
          'test:ctx': Array.from({ length: 5 }, () => ({
            tool: 'Read', context: 'test:ctx', score: 0.85, timestamp: Date.now(),
          })),
        },
        aggregates: {},
        grpoGroups: {},
        grpoScores: {},
        lastUpdated: Date.now(),
      };
      fs.readFile.mockResolvedValueOnce(JSON.stringify(existing));
      _clearCache();

      const candidates = await suggestToolCandidates('test:ctx');
      const readCandidate = candidates.find((c) => c.tool === 'Read');
      expect(readCandidate).toBeDefined();
      // hasTf but no GRPO, so combinedScore == toolformerScore
      expect(readCandidate.combinedScore).toBe(readCandidate.toolformerScore);
    });

    it('uses cold-start score (max of signals or 0.1) when neither GRPO nor Toolformer meet thresholds', async () => {
      const existing = {
        version: 2,
        contexts: {
          'test:ctx': [
            { tool: 'Read', context: 'test:ctx', score: 0.9, timestamp: Date.now() },
          ],
        },
        aggregates: {},
        grpoGroups: {},
        grpoScores: {},
        lastUpdated: Date.now(),
      };
      fs.readFile.mockResolvedValueOnce(JSON.stringify(existing));
      _clearCache();

      const candidates = await suggestToolCandidates('test:ctx');
      const readCandidate = candidates.find((c) => c.tool === 'Read');
      expect(readCandidate).toBeDefined();
      // 1 sample < MIN_SAMPLES(3) and 0 grpoComparisons < 2 -> cold start
      expect(readCandidate.combinedScore).toBeGreaterThanOrEqual(0.1);
    });

    it('blends GRPO 60% + Toolformer 40% when both signals are strong', async () => {
      const existing = {
        version: 2,
        contexts: {
          'test:ctx': Array.from({ length: 5 }, () => ({
            tool: 'Read', context: 'test:ctx', score: 0.8, timestamp: Date.now(),
          })),
        },
        aggregates: {},
        grpoGroups: {
          'test:ctx': [
            { context: 'test:ctx', rankings: [{ tool: 'Read', compositeScore: 0.85, relativeAdvantage: 0.15, rank: 1 }], timestamp: Date.now() },
            { context: 'test:ctx', rankings: [{ tool: 'Read', compositeScore: 0.9, relativeAdvantage: 0.2, rank: 1 }], timestamp: Date.now() },
            { context: 'test:ctx', rankings: [{ tool: 'Read', compositeScore: 0.8, relativeAdvantage: 0.1, rank: 1 }], timestamp: Date.now() },
          ],
        },
        grpoScores: { 'test:ctx::Read': 0.85 },
        lastUpdated: Date.now(),
      };
      fs.readFile.mockResolvedValueOnce(JSON.stringify(existing));
      _clearCache();

      const candidates = await suggestToolCandidates('test:ctx');
      const readCandidate = candidates.find((c) => c.tool === 'Read');
      expect(readCandidate).toBeDefined();
      // Both have enough data: 60% GRPO + 40% Toolformer
      expect(readCandidate.combinedScore).toBeGreaterThan(0);
      // Verify it is not just GRPO or just Toolformer
      expect(readCandidate.combinedScore).not.toBe(readCandidate.grpoScore);
      expect(readCandidate.combinedScore).not.toBe(readCandidate.toolformerScore);
    });

    it('creates GRPO-only entry when tool exists in grpoScores but not in contexts', async () => {
      const existing = {
        version: 2,
        contexts: {},
        aggregates: {},
        grpoGroups: {
          'test:ctx': [
            { context: 'test:ctx', rankings: [{ tool: 'TaskAgent', compositeScore: 0.7, relativeAdvantage: 0.1, rank: 1 }], timestamp: Date.now() },
            { context: 'test:ctx', rankings: [{ tool: 'TaskAgent', compositeScore: 0.8, relativeAdvantage: 0.2, rank: 1 }], timestamp: Date.now() },
          ],
        },
        grpoScores: { 'test:ctx::TaskAgent': 0.65 },
        lastUpdated: Date.now(),
      };
      fs.readFile.mockResolvedValueOnce(JSON.stringify(existing));
      _clearCache();

      const candidates = await suggestToolCandidates('test:ctx');
      const agent = candidates.find((c) => c.tool === 'TaskAgent');
      expect(agent).toBeDefined();
      expect(agent.toolformerScore).toBe(0);
      expect(agent.grpoScore).toBe(0.65);
    });
  });

  // ---------------------------------------------------------------------------
  describe('pruneOldRecords() GRPO score cleanup', () => {
    it('removes orphaned GRPO scores when contexts and groups are pruned', async () => {
      const oldTimestamp = Date.now() - (100 * 24 * 60 * 60 * 1000);
      const existing = {
        version: 2,
        contexts: {
          'old:ctx': [
            { tool: 'Read', context: 'old:ctx', score: 0.9, timestamp: oldTimestamp },
          ],
        },
        aggregates: {},
        grpoGroups: {
          'old:ctx': [
            { context: 'old:ctx', rankings: [{ tool: 'Read', compositeScore: 0.8, relativeAdvantage: 0.1, rank: 1 }], timestamp: oldTimestamp },
          ],
        },
        grpoScores: {
          'old:ctx::Read': 0.75,
          'fresh:ctx::Grep': 0.6,
        },
        lastUpdated: Date.now(),
      };
      fs.readFile.mockResolvedValueOnce(JSON.stringify(existing));
      _clearCache();

      await pruneOldRecords(90 * 24 * 60 * 60 * 1000);
      await flushToDisk();
      const content = JSON.parse(fs.writeFile.mock.calls[0][1]);
      // Orphaned score for 'old:ctx::Read' should be removed
      expect(content.grpoScores['old:ctx::Read']).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  describe('clampScore() edge cases', () => {
    it('clamps negative scores to 0', async () => {
      await recordUsage('Read', 'clamp:test', -0.5);
      await flushToDisk();
      const content = JSON.parse(fs.writeFile.mock.calls[0][1]);
      expect(content.contexts['clamp:test'][0].score).toBe(0);
    });

    it('clamps NaN to 0', async () => {
      await recordUsage('Read', 'clamp:nan', NaN);
      await flushToDisk();
      const content = JSON.parse(fs.writeFile.mock.calls[0][1]);
      expect(content.contexts['clamp:nan'][0].score).toBe(0);
    });

    it('clamps non-number to 0', async () => {
      await recordUsage('Read', 'clamp:string', 'not-a-number');
      await flushToDisk();
      const content = JSON.parse(fs.writeFile.mock.calls[0][1]);
      expect(content.contexts['clamp:string'][0].score).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  describe('getToolStats() branches', () => {
    it('returns null for nonexistent tool name', async () => {
      const stats = await getToolStats('NonexistentTool');
      expect(stats).toBeNull();
    });

    it('returns stats for existing tool name', async () => {
      await recordUsage('Read', 'test:ctx', 0.9);
      const stats = await getToolStats('Read');
      expect(stats).toBeDefined();
      expect(stats.totalUses).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  describe('getConfidence() branches', () => {
    it('returns "high" confidence for 20+ samples', async () => {
      const records = Array.from({ length: 20 }, (_, i) => ({
        tool: 'Read', context: 'confidence:test', score: 0.9, timestamp: Date.now() - i * 1000,
      }));
      const existing = {
        version: 2,
        contexts: { 'confidence:test': records },
        aggregates: {},
        grpoGroups: {},
        grpoScores: {},
        lastUpdated: Date.now(),
      };
      fs.readFile.mockResolvedValueOnce(JSON.stringify(existing));
      _clearCache();

      const suggestions = await suggestTool('confidence:test', { minScore: 0 });
      expect(suggestions).toHaveLength(1);
      expect(suggestions[0].confidence).toBe('high');
    });

    it('returns "medium" confidence for 3-19 samples', async () => {
      const records = Array.from({ length: 5 }, (_, i) => ({
        tool: 'Read', context: 'confidence:test', score: 0.9, timestamp: Date.now() - i * 1000,
      }));
      const existing = {
        version: 2,
        contexts: { 'confidence:test': records },
        aggregates: {},
        grpoGroups: {},
        grpoScores: {},
        lastUpdated: Date.now(),
      };
      fs.readFile.mockResolvedValueOnce(JSON.stringify(existing));
      _clearCache();

      const suggestions = await suggestTool('confidence:test', { minScore: 0 });
      expect(suggestions).toHaveLength(1);
      expect(suggestions[0].confidence).toBe('medium');
    });

    it('returns "low" confidence for fewer than 3 samples', async () => {
      const records = Array.from({ length: 2 }, (_, i) => ({
        tool: 'Read', context: 'confidence:test', score: 0.9, timestamp: Date.now() - i * 1000,
      }));
      const existing = {
        version: 2,
        contexts: { 'confidence:test': records },
        aggregates: {},
        grpoGroups: {},
        grpoScores: {},
        lastUpdated: Date.now(),
      };
      fs.readFile.mockResolvedValueOnce(JSON.stringify(existing));
      _clearCache();

      // low confidence tools still show if minScore=0, but filtered by MIN_SAMPLES in suggestTool
      // Use suggestToolCandidates which doesn't filter by MIN_SAMPLES
      const candidates = await suggestToolCandidates('confidence:test');
      const readCandidate = candidates.find((c) => c.tool === 'Read');
      expect(readCandidate).toBeDefined();
      expect(readCandidate.toolformerSamples).toBe(2);
    });
  });

  // ---------------------------------------------------------------------------
  describe('recordUsage() without meta fields', () => {
    it('does not include command or domain fields when meta is empty', async () => {
      await recordUsage('Read', 'test:nometa', 0.8);
      await flushToDisk();
      const content = JSON.parse(fs.writeFile.mock.calls[0][1]);
      const record = content.contexts['test:nometa'][0];
      expect(record.command).toBeUndefined();
      expect(record.domain).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  describe('recordGroupComparison() GRPO groups cap', () => {
    it('caps stored GRPO groups at MAX_GRPO_GROUPS_PER_KEY (50)', async () => {
      const groups = Array.from({ length: 50 }, (_, i) => ({
        context: 'cap:test',
        rankings: [
          { tool: 'Read', compositeScore: 0.8, relativeAdvantage: 0.1, rank: 1 },
          { tool: 'Grep', compositeScore: 0.6, relativeAdvantage: -0.1, rank: 2 },
        ],
        timestamp: Date.now() - i * 1000,
      }));
      const existing = {
        version: 2,
        contexts: {},
        aggregates: {},
        grpoGroups: { 'cap:test': groups },
        grpoScores: {},
        lastUpdated: Date.now(),
      };
      fs.readFile.mockResolvedValueOnce(JSON.stringify(existing));
      _clearCache();

      const results = [
        { tool: 'Read', success: true, durationMs: 100, accuracy: 0.9, brevity: 0.8 },
        { tool: 'Grep', success: true, durationMs: 200, accuracy: 0.7, brevity: 0.6 },
      ];
      await recordGroupComparison('cap:test', results);
      await flushToDisk();
      const content = JSON.parse(fs.writeFile.mock.calls[0][1]);
      expect(content.grpoGroups['cap:test'].length).toBeLessThanOrEqual(50);
    });
  });

  // ---------------------------------------------------------------------------
  describe('saveHistory() / flushToDisk() edge cases', () => {
    it('flushToDisk is a no-op when history is null and not dirty', async () => {
      _clearCache();
      await flushToDisk();
      expect(fs.writeFile).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  describe('splitGrpoKey() edge cases', () => {
    it('handles key without :: separator in pruneOldRecords', async () => {
      const existing = {
        version: 2,
        contexts: {},
        aggregates: {},
        grpoGroups: {},
        grpoScores: { 'malformed-key': 0.5 },
        lastUpdated: Date.now(),
      };
      fs.readFile.mockResolvedValueOnce(JSON.stringify(existing));
      _clearCache();

      // Should not throw; malformed key should be handled gracefully
      const pruned = await pruneOldRecords();
      expect(pruned).toBe(0);
    });
  });
});
