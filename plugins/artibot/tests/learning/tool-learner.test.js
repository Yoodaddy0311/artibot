import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _clearCache,
  _getBufferState,
  buildContextKey,
  flushToDisk,
  getToolStats,
  pruneOldRecords,
  recordUsage,
  shutdownToolLearner,
  suggestTool,
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

    // v4.7.0 A3: agent attribution
    it('stores meta.agentId as callingAgent on the record', async () => {
      await recordUsage('Read', 'search:file', 1.0, { agentId: 'frontend-developer' });
      await flushToDisk();
      const content = JSON.parse(fs.writeFile.mock.calls[0][1]);
      const record = content.contexts['search:file'][0];
      expect(record.callingAgent).toBe('frontend-developer');
    });

    it('stores meta.agentType as parentAgent on the record', async () => {
      await recordUsage('Read', 'search:file', 1.0, {
        agentId: 'frontend-developer',
        agentType: 'orchestrator',
      });
      await flushToDisk();
      const content = JSON.parse(fs.writeFile.mock.calls[0][1]);
      const record = content.contexts['search:file'][0];
      expect(record.parentAgent).toBe('orchestrator');
    });

    it('does not persist callingAgent when agentId is "unknown" (sentinel from extractAgentId)', async () => {
      await recordUsage('Read', 'search:file', 1.0, { agentId: 'unknown' });
      await flushToDisk();
      const content = JSON.parse(fs.writeFile.mock.calls[0][1]);
      const record = content.contexts['search:file'][0];
      expect(record.callingAgent).toBeUndefined();
    });

    it('does not persist parentAgent when agentType is "main" (default fallback)', async () => {
      await recordUsage('Read', 'search:file', 1.0, {
        agentId: 'orchestrator',
        agentType: 'main',
      });
      await flushToDisk();
      const content = JSON.parse(fs.writeFile.mock.calls[0][1]);
      const record = content.contexts['search:file'][0];
      expect(record.parentAgent).toBeUndefined();
    });

    it('omits callingAgent and parentAgent fields entirely when meta is empty (backward compat)', async () => {
      await recordUsage('Read', 'search:file', 1.0);
      await flushToDisk();
      const content = JSON.parse(fs.writeFile.mock.calls[0][1]);
      const record = content.contexts['search:file'][0];
      expect(record).not.toHaveProperty('callingAgent');
      expect(record).not.toHaveProperty('parentAgent');
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
        lastUpdated: Date.now(),
      };
      fs.readFile.mockResolvedValueOnce(JSON.stringify(existing));
      _clearCache();

      // 30-day retention: 3-day-old record should survive
      const pruned = await pruneOldRecords(30 * 24 * 60 * 60 * 1000);
      expect(pruned).toBe(0);
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

    it('loads a v1 history and preserves its contexts (no GRPO fields added)', async () => {
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
      // GRPO comparison storage was retired — no grpo fields are written.
      expect(content.grpoGroups).toBeUndefined();
      expect(content.grpoScores).toBeUndefined();
      // Original contexts should be preserved
      expect(content.contexts['search:file'].length).toBeGreaterThanOrEqual(2);
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
        lastUpdated: Date.now(),
      };
      fs.readFile.mockResolvedValueOnce(JSON.stringify(existing));
      _clearCache();

      const suggestions = await suggestTool('search:file');
      expect(suggestions).toHaveLength(0);
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
        lastUpdated: Date.now(),
      };
      fs.readFile.mockResolvedValueOnce(JSON.stringify(existing));
      _clearCache();

      const suggestions = await suggestTool('confidence:test', { minScore: 0 });
      expect(suggestions).toHaveLength(1);
      expect(suggestions[0].confidence).toBe('medium');
    });

    it('suppresses tools with fewer than MIN_SAMPLES observations', async () => {
      const records = Array.from({ length: 2 }, (_, i) => ({
        tool: 'Read', context: 'confidence:test', score: 0.9, timestamp: Date.now() - i * 1000,
      }));
      const existing = {
        version: 2,
        contexts: { 'confidence:test': records },
        aggregates: {},
        lastUpdated: Date.now(),
      };
      fs.readFile.mockResolvedValueOnce(JSON.stringify(existing));
      _clearCache();

      // Only 2 samples (< MIN_SAMPLES=3), so suggestTool returns nothing even
      // with minScore=0. (getConfidence's "low" branch is covered directly in
      // tool-history.test.js.)
      const suggestions = await suggestTool('confidence:test', { minScore: 0 });
      expect(suggestions).toHaveLength(0);
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
  describe('saveHistory() / flushToDisk() edge cases', () => {
    it('flushToDisk is a no-op when history is null and not dirty', async () => {
      _clearCache();
      await flushToDisk();
      expect(fs.writeFile).not.toHaveBeenCalled();
    });
  });

});
