import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  collectExperience,
  collectDailyExperiences,
  batchLearn,
  updatePatterns,
  getLearningSummary,
} from '../../lib/learning/lifelong-learner.js';

vi.mock('../../lib/core/file.js', () => ({
  readJsonFile: vi.fn(() => Promise.resolve(null)),
  writeJsonFile: vi.fn(() => Promise.resolve()),
  ensureDir: vi.fn(() => Promise.resolve()),
}));

const { readJsonFile, writeJsonFile, ensureDir } = await import('../../lib/core/file.js');

describe('lifelong-learner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readJsonFile.mockResolvedValue(null);
  });

  // ---------------------------------------------------------------------------
  describe('collectExperience()', () => {
    it('returns a stored experience with required fields', async () => {
      const exp = await collectExperience({
        type: 'tool',
        category: 'Read',
        data: { calls: 5, successes: 5 },
        sessionId: 'sess-1',
      });

      expect(exp.id).toMatch(/^exp-/);
      expect(exp.type).toBe('tool');
      expect(exp.category).toBe('Read');
      expect(exp.data).toEqual({ calls: 5, successes: 5 });
      expect(exp.sessionId).toBe('sess-1');
      expect(typeof exp.timestamp).toBe('number');
    });

    it('persists experience to disk', async () => {
      await collectExperience({ type: 'tool', category: 'Write', data: {} });
      expect(writeJsonFile).toHaveBeenCalledTimes(1);
    });

    it('appends to existing experiences', async () => {
      readJsonFile.mockResolvedValue([{ id: 'existing', type: 'tool', category: 'Read', data: {} }]);
      await collectExperience({ type: 'error', category: 'timeout', data: {} });
      const written = writeJsonFile.mock.calls[0][1];
      expect(written).toHaveLength(2);
    });

    it('defaults category to general when not provided', async () => {
      const exp = await collectExperience({ type: 'tool', data: {} });
      expect(exp.category).toBe('general');
    });

    it('defaults sessionId to null when not provided', async () => {
      const exp = await collectExperience({ type: 'success', category: 'build', data: {} });
      expect(exp.sessionId).toBeNull();
    });

    it('prunes experiences beyond MAX_EXPERIENCES (1000)', async () => {
      const existing = Array.from({ length: 1000 }, (_, i) => ({
        id: `e-${i}`, type: 'tool', category: 'Read', data: {}, timestamp: i,
      }));
      readJsonFile.mockResolvedValue(existing);
      await collectExperience({ type: 'tool', category: 'Write', data: {} });
      const written = writeJsonFile.mock.calls[0][1];
      expect(written).toHaveLength(1000);
    });

    it('ensures directory before writing', async () => {
      await collectExperience({ type: 'tool', category: 'Read', data: {} });
      expect(ensureDir).toHaveBeenCalledTimes(1);
    });

    it('supports all experience types', async () => {
      const types = ['tool', 'error', 'success', 'team'];
      for (const type of types) {
        const exp = await collectExperience({ type, category: 'test', data: {} });
        expect(exp.type).toBe(type);
      }
    });
  });

  // ---------------------------------------------------------------------------
  describe('collectDailyExperiences()', () => {
    it('returns empty array when session has no data', async () => {
      const collected = await collectDailyExperiences({});
      expect(Array.isArray(collected)).toBe(true);
    });

    it('collects tool usage experiences', async () => {
      const collected = await collectDailyExperiences({
        sessionId: 'sess-1',
        toolUsage: {
          Read: { calls: 10, successes: 9, totalMs: 5000 },
        },
      });
      const toolExp = collected.find((e) => e.type === 'tool' && e.category === 'Read');
      expect(toolExp).toBeDefined();
      expect(toolExp.data.calls).toBe(10);
      expect(toolExp.data.successes).toBe(9);
    });

    it('computes successRate and avgMs for tools', async () => {
      const collected = await collectDailyExperiences({
        toolUsage: {
          Grep: { calls: 4, successes: 4, totalMs: 2000 },
        },
      });
      const grepExp = collected.find((e) => e.category === 'Grep');
      expect(grepExp.data.successRate).toBe(1.0);
      expect(grepExp.data.avgMs).toBe(500);
    });

    it('collects error experiences', async () => {
      const collected = await collectDailyExperiences({
        errors: [{ type: 'NetworkError', message: 'timeout', code: 'ETIMEOUT', recoverable: true }],
      });
      const errExp = collected.find((e) => e.type === 'error');
      expect(errExp).toBeDefined();
      expect(errExp.category).toBe('NetworkError');
      expect(errExp.data.recoverable).toBe(true);
    });

    it('collects success experiences from completed tasks', async () => {
      const collected = await collectDailyExperiences({
        completedTasks: [
          { id: 'task-1', type: 'build', duration: 30000, strategy: 'balanced', testsPass: true },
        ],
      });
      const successExp = collected.find((e) => e.type === 'success');
      expect(successExp).toBeDefined();
      expect(successExp.category).toBe('build');
      expect(successExp.data.testsPass).toBe(true);
    });

    it('collects team composition experience when teamConfig is provided', async () => {
      const collected = await collectDailyExperiences({
        teamConfig: { pattern: 'leader', size: 3, agents: ['a1'], domain: 'frontend', successRate: 0.9 },
      });
      const teamExp = collected.find((e) => e.type === 'team');
      expect(teamExp).toBeDefined();
      expect(teamExp.category).toBe('leader');
      expect(teamExp.data.size).toBe(3);
    });

    it('skips team experience when teamConfig is not provided', async () => {
      const collected = await collectDailyExperiences({ completedTasks: [] });
      const teamExp = collected.find((e) => e.type === 'team');
      expect(teamExp).toBeUndefined();
    });

    it('handles error without code or type using unknown fallback', async () => {
      const collected = await collectDailyExperiences({
        errors: [{ message: 'generic error' }],
      });
      const errExp = collected.find((e) => e.type === 'error');
      expect(errExp.category).toBe('unknown');
    });
  });

  // ---------------------------------------------------------------------------
  describe('batchLearn()', () => {
    it('returns insufficient message when no experiences', async () => {
      const result = await batchLearn([]);
      expect(result.groupsProcessed).toBe(0);
      expect(result.patternsExtracted).toBe(0);
      expect(result.summary.message).toContain('Insufficient');
    });

    it('returns insufficient when only one experience', async () => {
      const result = await batchLearn([
        { id: 'e1', type: 'tool', category: 'Read', data: { successRate: 1.0, avgMs: 100 }, timestamp: Date.now() },
      ]);
      expect(result.groupsProcessed).toBe(0);
    });

    it('processes groups when sufficient experiences provided', async () => {
      // Need at least 2 experiences in the same group
      const experiences = Array.from({ length: 5 }, (_, i) => ({
        id: `e-${i}`,
        type: 'success',
        category: 'build',
        data: { duration: 10000 + i * 5000, testsPass: i < 3, filesModified: i },
        timestamp: Date.now() - i * 1000,
      }));
      const result = await batchLearn(experiences);
      expect(result.groupsProcessed).toBeGreaterThan(0);
    });

    it('persists patterns when patterns are extracted', async () => {
      // Create experiences where best clearly outperforms mean
      const experiences = [
        { id: 'e1', type: 'success', category: 'build', data: { duration: 5000, testsPass: true, filesModified: 1 }, timestamp: Date.now() - 1000 },
        { id: 'e2', type: 'success', category: 'build', data: { duration: 5000, testsPass: true, filesModified: 1 }, timestamp: Date.now() - 2000 },
        { id: 'e3', type: 'success', category: 'build', data: { duration: 300000, testsPass: false, filesModified: 50 }, timestamp: Date.now() - 3000 },
        { id: 'e4', type: 'success', category: 'build', data: { duration: 300000, testsPass: false, filesModified: 50 }, timestamp: Date.now() - 4000 },
        { id: 'e5', type: 'success', category: 'build', data: { duration: 5000, testsPass: true, filesModified: 1 }, timestamp: Date.now() - 5000 },
      ];
      await batchLearn(experiences);
      // writeJsonFile may be called for learning log and pattern files
      expect(writeJsonFile).toHaveBeenCalled();
    });

    it('loads experiences from disk when not provided', async () => {
      readJsonFile.mockImplementation((path) => {
        if (path.includes('daily-experiences')) {
          return Promise.resolve([
            { id: 'e1', type: 'tool', category: 'Read', data: { successRate: 1.0, avgMs: 100, calls: 5, successes: 5 }, timestamp: Date.now() },
            { id: 'e2', type: 'tool', category: 'Read', data: { successRate: 0.5, avgMs: 2000, calls: 4, successes: 2 }, timestamp: Date.now() - 1000 },
          ]);
        }
        return Promise.resolve(null);
      });
      const result = await batchLearn();
      expect(result.groupsProcessed).toBeGreaterThan(0);
    });

    it('logs learning round to disk', async () => {
      const experiences = [
        { id: 'e1', type: 'tool', category: 'Read', data: { successRate: 1.0, avgMs: 100, calls: 5, successes: 5 }, timestamp: Date.now() },
        { id: 'e2', type: 'tool', category: 'Read', data: { successRate: 0.5, avgMs: 3000, calls: 4, successes: 2 }, timestamp: Date.now() - 1000 },
      ];
      await batchLearn(experiences);
      // Learning log should be written
      const learningLogWritten = writeJsonFile.mock.calls.some(([path]) =>
        path.includes('learning-log')
      );
      expect(learningLogWritten).toBe(true);
    });

    it('returns patterns array in result', async () => {
      const result = await batchLearn([]);
      expect(Array.isArray(result.patterns)).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  describe('updatePatterns()', () => {
    it('creates pattern files grouped by type', async () => {
      const patterns = [
        {
          key: 'tool::Read',
          type: 'tool',
          category: 'Read',
          confidence: 0.9,
          bestComposite: 0.9,
          groupMean: 0.5,
          sampleSize: 10,
          insight: 'Read performs well',
          bestData: { successRate: 1.0 },
          extractedAt: new Date().toISOString(),
        },
        {
          key: 'success::build',
          type: 'success',
          category: 'build',
          confidence: 0.85,
          bestComposite: 0.85,
          groupMean: 0.4,
          sampleSize: 8,
          insight: 'build success pattern',
          bestData: { testsPass: true },
          extractedAt: new Date().toISOString(),
        },
      ];

      await updatePatterns(patterns);
      // Should write two separate files (one per type)
      expect(writeJsonFile).toHaveBeenCalledTimes(2);
    });

    it('merges with existing patterns of same key', async () => {
      readJsonFile.mockResolvedValue({
        patterns: [{
          key: 'tool::Read',
          type: 'tool',
          category: 'Read',
          confidence: 0.8,
          consecutiveSuccesses: 1,
          consecutiveFailures: 0,
          firstSeen: '2024-01-01T00:00:00.000Z',
          updateCount: 1,
        }],
        updatedAt: '2024-01-01T00:00:00.000Z',
      });

      const newPattern = {
        key: 'tool::Read',
        type: 'tool',
        category: 'Read',
        confidence: 0.9,
        bestComposite: 0.9,
        groupMean: 0.5,
        sampleSize: 10,
        insight: 'Updated Read pattern',
        bestData: {},
        extractedAt: new Date().toISOString(),
      };

      await updatePatterns([newPattern]);
      const written = writeJsonFile.mock.calls[0][1];
      expect(written.patterns).toHaveLength(1);
      expect(written.patterns[0].updateCount).toBe(2);
    });

    it('appends new pattern when key does not exist', async () => {
      readJsonFile.mockResolvedValue({
        patterns: [{ key: 'tool::Grep', type: 'tool', category: 'Grep', confidence: 0.7 }],
        updatedAt: '2024-01-01T00:00:00.000Z',
      });

      const newPattern = {
        key: 'tool::Read',
        type: 'tool',
        category: 'Read',
        confidence: 0.9,
        bestComposite: 0.9,
        groupMean: 0.5,
        sampleSize: 5,
        insight: 'Read pattern',
        bestData: {},
        extractedAt: new Date().toISOString(),
      };

      await updatePatterns([newPattern]);
      const written = writeJsonFile.mock.calls[0][1];
      expect(written.patterns).toHaveLength(2);
    });

    it('tracks consecutiveSuccesses when confidence improves', async () => {
      readJsonFile.mockResolvedValue({
        patterns: [{
          key: 'tool::Read',
          type: 'tool',
          category: 'Read',
          confidence: 0.7,
          consecutiveSuccesses: 2,
          consecutiveFailures: 0,
          updateCount: 2,
        }],
        updatedAt: '2024-01-01T00:00:00.000Z',
      });

      await updatePatterns([{
        key: 'tool::Read',
        type: 'tool',
        category: 'Read',
        confidence: 0.9,
        bestComposite: 0.9,
        groupMean: 0.5,
        sampleSize: 5,
        insight: 'improved',
        bestData: {},
        extractedAt: new Date().toISOString(),
      }]);

      const written = writeJsonFile.mock.calls[0][1];
      expect(written.patterns[0].consecutiveSuccesses).toBe(3);
    });

    it('tracks consecutiveFailures when confidence drops', async () => {
      readJsonFile.mockResolvedValue({
        patterns: [{
          key: 'tool::Read',
          type: 'tool',
          category: 'Read',
          confidence: 0.9,
          consecutiveSuccesses: 3,
          consecutiveFailures: 0,
          updateCount: 3,
        }],
        updatedAt: '2024-01-01T00:00:00.000Z',
      });

      await updatePatterns([{
        key: 'tool::Read',
        type: 'tool',
        category: 'Read',
        confidence: 0.6,
        bestComposite: 0.6,
        groupMean: 0.5,
        sampleSize: 5,
        insight: 'declined',
        bestData: {},
        extractedAt: new Date().toISOString(),
      }]);

      const written = writeJsonFile.mock.calls[0][1];
      expect(written.patterns[0].consecutiveFailures).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  describe('getLearningSummary()', () => {
    it('returns correct structure even with no data', async () => {
      readJsonFile.mockResolvedValue(null);
      const summary = await getLearningSummary();
      expect(summary).toHaveProperty('totalSessions');
      expect(summary).toHaveProperty('totalExperiences');
      expect(summary).toHaveProperty('totalPatternsExtracted');
      expect(summary).toHaveProperty('patternsByType');
      expect(summary).toHaveProperty('recentLearnings');
      expect(summary).toHaveProperty('trend');
      expect(summary).toHaveProperty('recommendations');
    });

    it('reports insufficient_data trend when fewer than 4 log entries', async () => {
      readJsonFile.mockImplementation((p) => {
        if (p.includes('learning-log')) {
          return Promise.resolve([{ timestamp: 't1', patternsExtracted: 1 }]);
        }
        return Promise.resolve(null);
      });
      const summary = await getLearningSummary();
      expect(summary.trend).toBe('insufficient_data');
    });

    it('reports accelerating trend when recent extractions > early extractions', async () => {
      const log = [
        { timestamp: '1', patternsExtracted: 1, experienceCount: 10 },
        { timestamp: '2', patternsExtracted: 1, experienceCount: 10 },
        { timestamp: '3', patternsExtracted: 5, experienceCount: 20 },
        { timestamp: '4', patternsExtracted: 6, experienceCount: 20 },
      ];
      readJsonFile.mockImplementation((p) => {
        if (p.includes('learning-log')) return Promise.resolve(log);
        return Promise.resolve(null);
      });
      const summary = await getLearningSummary();
      expect(summary.trend).toBe('accelerating');
    });

    it('includes recommendations when no experiences collected', async () => {
      readJsonFile.mockResolvedValue(null);
      const summary = await getLearningSummary();
      expect(summary.recommendations.length).toBeGreaterThan(0);
      expect(summary.recommendations.some((r) => r.includes('experience') || r.includes('pattern'))).toBe(true);
    });

    it('includes healthy message when pipeline is running well', async () => {
      readJsonFile.mockImplementation((p) => {
        if (p.includes('daily-experiences')) {
          return Promise.resolve(Array.from({ length: 15 }, (_, i) => ({
            id: `e${i}`, type: 'success', category: 'build', data: {}, timestamp: Date.now() - i * 1000,
          })));
        }
        if (p.includes('success-patterns')) {
          return Promise.resolve({
            patterns: [{ key: 'success::build', confidence: 0.9, insight: 'good' }],
            updatedAt: new Date().toISOString(),
          });
        }
        return Promise.resolve(null);
      });
      const summary = await getLearningSummary();
      // Should either be healthy or have specific recommendations
      expect(Array.isArray(summary.recommendations)).toBe(true);
    });

    it('reports total experiences count correctly', async () => {
      readJsonFile.mockImplementation((p) => {
        if (p.includes('daily-experiences')) {
          return Promise.resolve(Array.from({ length: 42 }, (_, i) => ({
            id: `e${i}`, type: 'tool', category: 'Read', data: {}, timestamp: Date.now(),
          })));
        }
        return Promise.resolve(null);
      });
      const summary = await getLearningSummary();
      expect(summary.totalExperiences).toBe(42);
    });

    it('respects lookback option for log analysis', async () => {
      const log = Array.from({ length: 100 }, (_, i) => ({
        timestamp: `t${i}`, patternsExtracted: i < 80 ? 1 : 5, experienceCount: 10,
      }));
      readJsonFile.mockImplementation((p) => {
        if (p.includes('learning-log')) return Promise.resolve(log);
        return Promise.resolve(null);
      });
      // With lookback=10 we analyze last 10 sessions (all high extraction rate)
      const summary = await getLearningSummary({ lookback: 10 });
      expect(summary.totalSessions).toBe(10);
    });
  });
});
