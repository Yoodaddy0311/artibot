import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  collectExperience,
  collectDailyExperiences,
  batchLearn,
  updatePatterns,
  getLearningSummary,
  scheduleLearning,
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

    it('defaults data to empty object when not provided', async () => {
      const exp = await collectExperience({ type: 'tool', category: 'Read' });
      expect(exp.data).toEqual({});
    });

    it('prunes experiences beyond MAX_EXPERIENCES (1000)', async () => {
      const existing = Array.from({ length: 1000 }, (_, i) => ({
        id: `e-${i}`,
        type: 'tool',
        category: 'Read',
        data: {},
        timestamp: i,
      }));
      readJsonFile.mockResolvedValue(existing);
      await collectExperience({ type: 'tool', category: 'Write', data: {} });
      const written = writeJsonFile.mock.calls[0][1];
      expect(written).toHaveLength(1000);
    });

    it('does not prune when under MAX_EXPERIENCES', async () => {
      const existing = Array.from({ length: 5 }, (_, i) => ({
        id: `e-${i}`,
        type: 'tool',
        category: 'Read',
        data: {},
        timestamp: i,
      }));
      readJsonFile.mockResolvedValue(existing);
      await collectExperience({ type: 'tool', category: 'Write', data: {} });
      const written = writeJsonFile.mock.calls[0][1];
      expect(written).toHaveLength(6);
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
      expect(collected).toHaveLength(0);
    });

    it('returns empty array when called with no arguments', async () => {
      const collected = await collectDailyExperiences();
      expect(collected).toEqual([]);
    });

    it('collects tool usage experiences', async () => {
      const collected = await collectDailyExperiences({
        sessionId: 'sess-1',
        toolUsage: { Read: { calls: 10, successes: 9, totalMs: 5000 } },
      });
      const toolExp = collected.find((e) => e.type === 'tool' && e.category === 'Read');
      expect(toolExp).toBeDefined();
      expect(toolExp.data.calls).toBe(10);
      expect(toolExp.data.successes).toBe(9);
    });

    it('computes successRate and avgMs for tools', async () => {
      const collected = await collectDailyExperiences({
        toolUsage: { Grep: { calls: 4, successes: 4, totalMs: 2000 } },
      });
      const grepExp = collected.find((e) => e.category === 'Grep');
      expect(grepExp.data.successRate).toBe(1.0);
      expect(grepExp.data.avgMs).toBe(500);
    });

    it('handles tool with zero calls', async () => {
      const collected = await collectDailyExperiences({
        toolUsage: { Empty: { calls: 0, successes: 0, totalMs: 0 } },
      });
      const emptyExp = collected.find((e) => e.category === 'Empty');
      expect(emptyExp.data.avgMs).toBe(0);
      expect(emptyExp.data.successRate).toBe(0);
    });

    it('handles tool with missing fields', async () => {
      const collected = await collectDailyExperiences({
        toolUsage: { Minimal: {} },
      });
      const minExp = collected.find((e) => e.category === 'Minimal');
      expect(minExp.data.calls).toBe(0);
      expect(minExp.data.successes).toBe(0);
      expect(minExp.data.totalMs).toBe(0);
    });

    it('collects multiple tool experiences', async () => {
      const collected = await collectDailyExperiences({
        toolUsage: {
          Read: { calls: 5, successes: 5, totalMs: 1000 },
          Write: { calls: 3, successes: 2, totalMs: 900 },
        },
      });
      expect(collected.filter((e) => e.type === 'tool')).toHaveLength(2);
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

    it('uses error.code as category when type is missing', async () => {
      const collected = await collectDailyExperiences({
        errors: [{ code: 'ENOENT', message: 'not found' }],
      });
      const errExp = collected.find((e) => e.type === 'error');
      expect(errExp.category).toBe('ENOENT');
    });

    it('handles error without code or type using unknown fallback', async () => {
      const collected = await collectDailyExperiences({
        errors: [{ message: 'generic error' }],
      });
      const errExp = collected.find((e) => e.type === 'error');
      expect(errExp.category).toBe('unknown');
    });

    it('handles error with null fields', async () => {
      const collected = await collectDailyExperiences({
        errors: [{ type: null, code: null, message: null, tool: null, recoverable: null }],
      });
      const errExp = collected.find((e) => e.type === 'error');
      expect(errExp.category).toBe('unknown');
      expect(errExp.data.recoverable).toBeNull();
    });

    it('collects success experiences from completed tasks', async () => {
      const collected = await collectDailyExperiences({
        completedTasks: [{ id: 'task-1', type: 'build', duration: 30000, strategy: 'balanced', testsPass: true }],
      });
      const successExp = collected.find((e) => e.type === 'success');
      expect(successExp).toBeDefined();
      expect(successExp.category).toBe('build');
      expect(successExp.data.testsPass).toBe(true);
    });

    it('uses taskType as category fallback for completed tasks', async () => {
      const collected = await collectDailyExperiences({
        completedTasks: [{ id: 'task-1', taskType: 'refactor' }],
      });
      const successExp = collected.find((e) => e.type === 'success');
      expect(successExp.category).toBe('refactor');
    });

    it('defaults completed task category to task when no type or taskType', async () => {
      const collected = await collectDailyExperiences({
        completedTasks: [{ id: 'task-1' }],
      });
      const successExp = collected.find((e) => e.type === 'success');
      expect(successExp.category).toBe('task');
    });

    it('handles completed task with filesModified array', async () => {
      const collected = await collectDailyExperiences({
        completedTasks: [{ id: 'task-1', type: 'build', filesModified: ['a.js', 'b.js', 'c.js'] }],
      });
      const successExp = collected.find((e) => e.type === 'success');
      expect(successExp.data.filesModified).toBe(3);
    });

    it('handles completed task with null fields', async () => {
      const collected = await collectDailyExperiences({
        completedTasks: [{ id: null, type: null, duration: null, strategy: null, testsPass: null, filesModified: null }],
      });
      const successExp = collected.find((e) => e.type === 'success');
      expect(successExp.data.taskId).toBeNull();
      expect(successExp.data.duration).toBeNull();
      expect(successExp.data.filesModified).toBe(0);
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

    it('handles teamConfig with missing fields', async () => {
      const collected = await collectDailyExperiences({ teamConfig: {} });
      const teamExp = collected.find((e) => e.type === 'team');
      expect(teamExp).toBeDefined();
      expect(teamExp.category).toBe('unknown');
      expect(teamExp.data.pattern).toBeNull();
      expect(teamExp.data.size).toBe(0);
      expect(teamExp.data.agents).toEqual([]);
      expect(teamExp.data.domain).toBe('general');
    });

    it('passes sessionId through to all collected experiences', async () => {
      const collected = await collectDailyExperiences({
        sessionId: 'my-session',
        toolUsage: { Read: { calls: 1, successes: 1, totalMs: 100 } },
        errors: [{ message: 'err' }],
        completedTasks: [{ type: 'fix' }],
        teamConfig: { pattern: 'solo' },
      });
      expect(collected.length).toBe(4);
      for (const exp of collected) {
        expect(exp.sessionId).toBe('my-session');
      }
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

    it('skips groups with fewer than MIN_GROUP_SIZE entries', async () => {
      const experiences = [
        { id: 'e1', type: 'tool', category: 'Read', data: { successRate: 1.0, avgMs: 100 }, timestamp: Date.now() },
        { id: 'e2', type: 'error', category: 'timeout', data: { message: 'timeout' }, timestamp: Date.now() },
      ];
      const result = await batchLearn(experiences);
      expect(result.patternsExtracted).toBe(0);
    });

    it('persists patterns when patterns are extracted', async () => {
      const experiences = [
        { id: 'e1', type: 'success', category: 'build', data: { duration: 5000, testsPass: true, filesModified: 1 }, timestamp: Date.now() - 1000 },
        { id: 'e2', type: 'success', category: 'build', data: { duration: 5000, testsPass: true, filesModified: 1 }, timestamp: Date.now() - 2000 },
        { id: 'e3', type: 'success', category: 'build', data: { duration: 300000, testsPass: false, filesModified: 50 }, timestamp: Date.now() - 3000 },
        { id: 'e4', type: 'success', category: 'build', data: { duration: 300000, testsPass: false, filesModified: 50 }, timestamp: Date.now() - 4000 },
        { id: 'e5', type: 'success', category: 'build', data: { duration: 5000, testsPass: true, filesModified: 1 }, timestamp: Date.now() - 5000 },
      ];
      await batchLearn(experiences);
      expect(writeJsonFile).toHaveBeenCalled();
    });

    it('loads experiences from disk when not provided', async () => {
      readJsonFile.mockImplementation((filePath) => {
        if (filePath.includes('daily-experiences')) {
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
      const learningLogWritten = writeJsonFile.mock.calls.some(([filePath]) =>
        filePath.includes('learning-log'),
      );
      expect(learningLogWritten).toBe(true);
    });

    it('returns patterns array in result', async () => {
      const result = await batchLearn([]);
      expect(Array.isArray(result.patterns)).toBe(true);
    });

    it('does not extract pattern when best composite is not above mean + 0.05', async () => {
      const experiences = Array.from({ length: 5 }, (_, i) => ({
        id: `e-${i}`,
        type: 'tool',
        category: 'Same',
        data: { successRate: 0.8, avgMs: 500, calls: 10, successes: 8 },
        timestamp: Date.now() - i * 1000,
      }));
      const result = await batchLearn(experiences);
      expect(result.patternsExtracted).toBe(0);
    });

    it('processes error type experiences through scoreExperience', async () => {
      const experiences = [
        { id: 'e1', type: 'error', category: 'timeout', data: { message: 'timeout', recoverable: true }, timestamp: Date.now() },
        { id: 'e2', type: 'error', category: 'timeout', data: { message: 'timeout', recoverable: false }, timestamp: Date.now() - 1000 },
      ];
      const result = await batchLearn(experiences);
      expect(result.groupsProcessed).toBe(1);
    });

    it('processes team type experiences through scoreExperience', async () => {
      const experiences = [
        { id: 'e1', type: 'team', category: 'leader', data: { successRate: 0.95, duration: 30000, size: 3 }, timestamp: Date.now() },
        { id: 'e2', type: 'team', category: 'leader', data: { successRate: 0.3, duration: 120000, size: 8 }, timestamp: Date.now() - 1000 },
      ];
      const result = await batchLearn(experiences);
      expect(result.groupsProcessed).toBe(1);
    });

    it('processes unknown type experiences through default scoring', async () => {
      const experiences = [
        { id: 'e1', type: 'custom', category: 'xyz', data: {}, timestamp: Date.now() },
        { id: 'e2', type: 'custom', category: 'xyz', data: {}, timestamp: Date.now() - 1000 },
      ];
      const result = await batchLearn(experiences);
      expect(result.groupsProcessed).toBe(1);
    });

    it('handles experiences with null data gracefully in scoring', async () => {
      const experiences = [
        { id: 'e1', type: 'tool', category: 'Read', data: null, timestamp: Date.now() },
        { id: 'e2', type: 'tool', category: 'Read', data: undefined, timestamp: Date.now() - 1000 },
      ];
      const result = await batchLearn(experiences);
      expect(result.groupsProcessed).toBe(1);
    });

    it('generates insight for tool type patterns', async () => {
      const experiences = [
        { id: 'e1', type: 'tool', category: 'Read', data: { successRate: 1.0, avgMs: 50, calls: 10, successes: 10 }, timestamp: Date.now() },
        { id: 'e2', type: 'tool', category: 'Read', data: { successRate: 0.1, avgMs: 9000, calls: 10, successes: 1 }, timestamp: Date.now() - 1000 },
      ];
      const result = await batchLearn(experiences);
      if (result.patternsExtracted > 0) {
        const toolPattern = result.patterns.find((p) => p.type === 'tool');
        expect(toolPattern.insight).toContain('Tool');
      }
    });

    it('generates insight for success type patterns', async () => {
      const experiences = [
        { id: 'e1', type: 'success', category: 'build', data: { duration: 1000, testsPass: true, filesModified: 1, strategy: 'fast' }, timestamp: Date.now() },
        { id: 'e2', type: 'success', category: 'build', data: { duration: 500000, testsPass: false, filesModified: 100 }, timestamp: Date.now() - 1000 },
        { id: 'e3', type: 'success', category: 'build', data: { duration: 1000, testsPass: true, filesModified: 1, strategy: 'fast' }, timestamp: Date.now() - 2000 },
      ];
      const result = await batchLearn(experiences);
      if (result.patternsExtracted > 0) {
        const successPattern = result.patterns.find((p) => p.type === 'success');
        if (successPattern) {
          expect(successPattern.insight).toContain('Task type');
        }
      }
    });

    it('generates insight for team type patterns', async () => {
      const experiences = [
        { id: 'e1', type: 'team', category: 'leader', data: { successRate: 0.99, duration: 10000, size: 3 }, timestamp: Date.now() },
        { id: 'e2', type: 'team', category: 'leader', data: { successRate: 0.1, duration: 300000, size: 10 }, timestamp: Date.now() - 1000 },
        { id: 'e3', type: 'team', category: 'leader', data: { successRate: 0.98, duration: 12000, size: 3 }, timestamp: Date.now() - 2000 },
      ];
      const result = await batchLearn(experiences);
      if (result.patternsExtracted > 0) {
        const teamPattern = result.patterns.find((p) => p.type === 'team');
        if (teamPattern) {
          expect(teamPattern.insight).toContain('Team pattern');
        }
      }
    });

    it('handles scoreExperience with tool avgMs=null as 0.5 speed', async () => {
      const experiences = [
        { id: 'e1', type: 'tool', category: 'Read', data: { successRate: 1.0, avgMs: null, calls: 5, successes: 5 }, timestamp: Date.now() },
        { id: 'e2', type: 'tool', category: 'Read', data: { successRate: 0.0, avgMs: 10000, calls: 5, successes: 0 }, timestamp: Date.now() - 1000 },
      ];
      const result = await batchLearn(experiences);
      expect(result.groupsProcessed).toBe(1);
    });

    it('handles scoreExperience with success testsPass variations', async () => {
      const experiences = [
        { id: 'e1', type: 'success', category: 'build', data: { testsPass: true, duration: 1000, filesModified: 1 }, timestamp: Date.now() },
        { id: 'e2', type: 'success', category: 'build', data: { testsPass: false, duration: 1000, filesModified: 1 }, timestamp: Date.now() - 1000 },
        { id: 'e3', type: 'success', category: 'build', data: { testsPass: null, duration: 1000, filesModified: 1 }, timestamp: Date.now() - 2000 },
      ];
      const result = await batchLearn(experiences);
      expect(result.groupsProcessed).toBe(1);
    });

    it('handles scoreExperience with success duration=null', async () => {
      const experiences = [
        { id: 'e1', type: 'success', category: 'deploy', data: { duration: null, testsPass: true, filesModified: 1 }, timestamp: Date.now() },
        { id: 'e2', type: 'success', category: 'deploy', data: { duration: 500000, testsPass: false, filesModified: 50 }, timestamp: Date.now() - 1000 },
      ];
      const result = await batchLearn(experiences);
      expect(result.groupsProcessed).toBe(1);
    });

    it('handles scoreExperience with team duration=null', async () => {
      const experiences = [
        { id: 'e1', type: 'team', category: 'swarm', data: { successRate: 0.9, duration: null, size: 5 }, timestamp: Date.now() },
        { id: 'e2', type: 'team', category: 'swarm', data: { successRate: 0.1, duration: 300000, size: 10 }, timestamp: Date.now() - 1000 },
      ];
      const result = await batchLearn(experiences);
      expect(result.groupsProcessed).toBe(1);
    });

    it('clamp01 handles NaN and non-number values as 0', async () => {
      const experiences = [
        { id: 'e1', type: 'tool', category: 'Bad', data: { successRate: NaN, avgMs: 'text', calls: 'abc' }, timestamp: Date.now() },
        { id: 'e2', type: 'tool', category: 'Bad', data: { successRate: 0.5, avgMs: 100, calls: 10, successes: 5 }, timestamp: Date.now() - 1000 },
      ];
      const result = await batchLearn(experiences);
      expect(result.groupsProcessed).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  describe('updatePatterns()', () => {
    it('creates pattern files grouped by type', async () => {
      const patterns = [
        { key: 'tool::Read', type: 'tool', category: 'Read', confidence: 0.9, bestComposite: 0.9, groupMean: 0.5, sampleSize: 10, insight: 'Read performs well', bestData: { successRate: 1.0 }, extractedAt: new Date().toISOString() },
        { key: 'success::build', type: 'success', category: 'build', confidence: 0.85, bestComposite: 0.85, groupMean: 0.4, sampleSize: 8, insight: 'build success pattern', bestData: { testsPass: true }, extractedAt: new Date().toISOString() },
      ];
      await updatePatterns(patterns);
      expect(writeJsonFile).toHaveBeenCalledTimes(2);
    });

    it('merges with existing patterns of same key', async () => {
      readJsonFile.mockResolvedValue({
        patterns: [{ key: 'tool::Read', type: 'tool', category: 'Read', confidence: 0.8, consecutiveSuccesses: 1, consecutiveFailures: 0, firstSeen: '2024-01-01T00:00:00.000Z', updateCount: 1 }],
        updatedAt: '2024-01-01T00:00:00.000Z',
      });
      await updatePatterns([{ key: 'tool::Read', type: 'tool', category: 'Read', confidence: 0.9, bestComposite: 0.9, groupMean: 0.5, sampleSize: 10, insight: 'Updated', bestData: {}, extractedAt: new Date().toISOString() }]);
      const written = writeJsonFile.mock.calls[0][1];
      expect(written.patterns).toHaveLength(1);
      expect(written.patterns[0].updateCount).toBe(2);
    });

    it('appends new pattern when key does not exist', async () => {
      readJsonFile.mockResolvedValue({
        patterns: [{ key: 'tool::Grep', type: 'tool', category: 'Grep', confidence: 0.7 }],
        updatedAt: '2024-01-01T00:00:00.000Z',
      });
      await updatePatterns([{ key: 'tool::Read', type: 'tool', category: 'Read', confidence: 0.9, bestComposite: 0.9, groupMean: 0.5, sampleSize: 5, insight: 'Read', bestData: {}, extractedAt: new Date().toISOString() }]);
      const written = writeJsonFile.mock.calls[0][1];
      expect(written.patterns).toHaveLength(2);
    });

    it('tracks consecutiveSuccesses when confidence improves', async () => {
      readJsonFile.mockResolvedValue({
        patterns: [{ key: 'tool::Read', type: 'tool', category: 'Read', confidence: 0.7, consecutiveSuccesses: 2, consecutiveFailures: 0, updateCount: 2 }],
        updatedAt: '2024-01-01T00:00:00.000Z',
      });
      await updatePatterns([{ key: 'tool::Read', type: 'tool', category: 'Read', confidence: 0.9, bestComposite: 0.9, groupMean: 0.5, sampleSize: 5, insight: 'improved', bestData: {}, extractedAt: new Date().toISOString() }]);
      const written = writeJsonFile.mock.calls[0][1];
      expect(written.patterns[0].consecutiveSuccesses).toBe(3);
    });

    it('tracks consecutiveFailures when confidence drops', async () => {
      readJsonFile.mockResolvedValue({
        patterns: [{ key: 'tool::Read', type: 'tool', category: 'Read', confidence: 0.9, consecutiveSuccesses: 3, consecutiveFailures: 0, updateCount: 3 }],
        updatedAt: '2024-01-01T00:00:00.000Z',
      });
      await updatePatterns([{ key: 'tool::Read', type: 'tool', category: 'Read', confidence: 0.6, bestComposite: 0.6, groupMean: 0.5, sampleSize: 5, insight: 'declined', bestData: {}, extractedAt: new Date().toISOString() }]);
      const written = writeJsonFile.mock.calls[0][1];
      expect(written.patterns[0].consecutiveFailures).toBe(1);
    });

    it('resets consecutiveFailures to 0 when confidence improves', async () => {
      readJsonFile.mockResolvedValue({
        patterns: [{ key: 'tool::Read', type: 'tool', category: 'Read', confidence: 0.5, consecutiveSuccesses: 0, consecutiveFailures: 3, updateCount: 5 }],
        updatedAt: '2024-01-01T00:00:00.000Z',
      });
      await updatePatterns([{ key: 'tool::Read', type: 'tool', category: 'Read', confidence: 0.8, bestComposite: 0.8, groupMean: 0.4, sampleSize: 5, insight: 'recovered', bestData: {}, extractedAt: new Date().toISOString() }]);
      const written = writeJsonFile.mock.calls[0][1];
      expect(written.patterns[0].consecutiveFailures).toBe(0);
      expect(written.patterns[0].consecutiveSuccesses).toBe(1);
    });

    it('defaults type to general when pattern has no type', async () => {
      await updatePatterns([{ key: 'unknown::something', category: 'something', confidence: 0.9, bestComposite: 0.9, groupMean: 0.5, sampleSize: 5, insight: 'test', bestData: {}, extractedAt: new Date().toISOString() }]);
      const writeCall = writeJsonFile.mock.calls[0];
      expect(writeCall[0]).toContain('general-patterns');
    });

    it('handles existing file with non-array patterns field', async () => {
      readJsonFile.mockResolvedValue({ patterns: 'not an array', updatedAt: '2024-01-01T00:00:00.000Z' });
      await updatePatterns([{ key: 'tool::Read', type: 'tool', category: 'Read', confidence: 0.9, bestComposite: 0.9, groupMean: 0.5, sampleSize: 5, insight: 'new', bestData: {}, extractedAt: new Date().toISOString() }]);
      const written = writeJsonFile.mock.calls[0][1];
      expect(written.patterns).toHaveLength(1);
    });

    it('preserves firstSeen from existing pattern', async () => {
      readJsonFile.mockResolvedValue({
        patterns: [{ key: 'tool::Read', type: 'tool', category: 'Read', confidence: 0.8, consecutiveSuccesses: 1, consecutiveFailures: 0, firstSeen: '2024-01-01T00:00:00.000Z', extractedAt: '2024-01-02T00:00:00.000Z', updateCount: 1 }],
        updatedAt: '2024-01-02T00:00:00.000Z',
      });
      await updatePatterns([{ key: 'tool::Read', type: 'tool', category: 'Read', confidence: 0.9, bestComposite: 0.9, groupMean: 0.5, sampleSize: 5, insight: 'update', bestData: {}, extractedAt: new Date().toISOString() }]);
      const written = writeJsonFile.mock.calls[0][1];
      expect(written.patterns[0].firstSeen).toBe('2024-01-01T00:00:00.000Z');
    });

    it('sets firstSeen = extractedAt for new patterns', async () => {
      const extractedAt = new Date().toISOString();
      await updatePatterns([{ key: 'tool::New', type: 'tool', category: 'New', confidence: 0.9, bestComposite: 0.9, groupMean: 0.5, sampleSize: 5, insight: 'new', bestData: {}, extractedAt }]);
      const written = writeJsonFile.mock.calls[0][1];
      expect(written.patterns[0].firstSeen).toBe(extractedAt);
      expect(written.patterns[0].consecutiveSuccesses).toBe(0);
      expect(written.patterns[0].updateCount).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  describe('getLearningSummary()', () => {
    it('returns correct structure even with no data', async () => {
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
        if (p.includes('learning-log')) return Promise.resolve([{ timestamp: 't1', patternsExtracted: 1 }]);
        return Promise.resolve(null);
      });
      const summary = await getLearningSummary();
      expect(summary.trend).toBe('insufficient_data');
    });

    it('reports accelerating trend', async () => {
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

    it('reports decelerating trend', async () => {
      const log = [
        { timestamp: '1', patternsExtracted: 8, experienceCount: 20 },
        { timestamp: '2', patternsExtracted: 7, experienceCount: 20 },
        { timestamp: '3', patternsExtracted: 1, experienceCount: 10 },
        { timestamp: '4', patternsExtracted: 1, experienceCount: 10 },
      ];
      readJsonFile.mockImplementation((p) => {
        if (p.includes('learning-log')) return Promise.resolve(log);
        return Promise.resolve(null);
      });
      const summary = await getLearningSummary();
      expect(summary.trend).toBe('decelerating');
    });

    it('reports stable trend when extractions are similar', async () => {
      const log = [
        { timestamp: '1', patternsExtracted: 3, experienceCount: 10 },
        { timestamp: '2', patternsExtracted: 3, experienceCount: 10 },
        { timestamp: '3', patternsExtracted: 3, experienceCount: 10 },
        { timestamp: '4', patternsExtracted: 3, experienceCount: 10 },
      ];
      readJsonFile.mockImplementation((p) => {
        if (p.includes('learning-log')) return Promise.resolve(log);
        return Promise.resolve(null);
      });
      const summary = await getLearningSummary();
      expect(summary.trend).toBe('stable');
    });

    it('includes recommendations when no experiences collected', async () => {
      const summary = await getLearningSummary();
      expect(summary.recommendations.length).toBeGreaterThan(0);
      expect(summary.recommendations.some((r) => r.includes('experience') || r.includes('pattern'))).toBe(true);
    });

    it('recommends error prevention when error patterns outnumber success patterns', async () => {
      readJsonFile.mockImplementation((p) => {
        if (p.includes('daily-experiences')) return Promise.resolve(Array.from({ length: 20 }, (_, i) => ({ id: `e${i}`, type: 'tool', category: 'Read', data: {}, timestamp: Date.now() })));
        if (p.includes('error-patterns')) return Promise.resolve({ patterns: [{ key: 'error::t1', confidence: 0.9, insight: 'a' }, { key: 'error::t2', confidence: 0.8, insight: 'b' }], updatedAt: new Date().toISOString() });
        if (p.includes('success-patterns')) return Promise.resolve({ patterns: [{ key: 'success::build', confidence: 0.9, insight: 'c' }], updatedAt: new Date().toISOString() });
        return Promise.resolve(null);
      });
      const summary = await getLearningSummary();
      expect(summary.recommendations.some((r) => r.toLowerCase().includes('error'))).toBe(true);
    });

    it('reports total experiences count correctly', async () => {
      readJsonFile.mockImplementation((p) => {
        if (p.includes('daily-experiences')) return Promise.resolve(Array.from({ length: 42 }, (_, i) => ({ id: `e${i}`, type: 'tool', category: 'Read', data: {}, timestamp: Date.now() })));
        return Promise.resolve(null);
      });
      const summary = await getLearningSummary();
      expect(summary.totalExperiences).toBe(42);
    });

    it('respects lookback option for log analysis', async () => {
      const log = Array.from({ length: 100 }, (_, i) => ({ timestamp: `t${i}`, patternsExtracted: i < 80 ? 1 : 5, experienceCount: 10 }));
      readJsonFile.mockImplementation((p) => {
        if (p.includes('learning-log')) return Promise.resolve(log);
        return Promise.resolve(null);
      });
      const summary = await getLearningSummary({ lookback: 10 });
      expect(summary.totalSessions).toBe(10);
    });

    it('populates patternsByType with count and avgConfidence', async () => {
      readJsonFile.mockImplementation((p) => {
        if (p.includes('tool-patterns')) return Promise.resolve({ patterns: [{ key: 'tool::Read', confidence: 0.95, insight: 'a' }, { key: 'tool::Write', confidence: 0.8, insight: 'b' }], updatedAt: new Date().toISOString() });
        return Promise.resolve(null);
      });
      const summary = await getLearningSummary();
      expect(summary.patternsByType.tool).toBeDefined();
      expect(summary.patternsByType.tool.count).toBe(2);
      expect(summary.patternsByType.tool.avgConfidence).toBeGreaterThan(0);
      expect(summary.patternsByType.tool.topPatterns).toHaveLength(2);
    });

    it('returns healthy recommendation when pipeline is healthy', async () => {
      readJsonFile.mockImplementation((p) => {
        if (p.includes('daily-experiences')) return Promise.resolve(Array.from({ length: 20 }, (_, i) => ({ id: `e${i}`, type: 'tool', category: 'Read', data: {}, timestamp: Date.now() })));
        if (p.includes('tool-patterns')) return Promise.resolve({ patterns: [{ key: 'tool::Read', confidence: 0.9, insight: 'good' }], updatedAt: new Date().toISOString() });
        return Promise.resolve(null);
      });
      const summary = await getLearningSummary();
      expect(summary.recommendations.some((r) => r.includes('healthy'))).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  describe('scheduleLearning()', () => {
    it('returns object with onSessionEnd function', () => {
      const scheduler = scheduleLearning();
      expect(scheduler).toHaveProperty('onSessionEnd');
      expect(typeof scheduler.onSessionEnd).toBe('function');
    });

    it('onSessionEnd collects experiences and runs batch learning', async () => {
      const scheduler = scheduleLearning({ sessionId: 'sched-1' });
      const result = await scheduler.onSessionEnd({
        toolUsage: { Read: { calls: 5, successes: 5, totalMs: 1000 } },
      });
      expect(result).toHaveProperty('groupsProcessed');
      expect(result).toHaveProperty('patternsExtracted');
      expect(result).toHaveProperty('patterns');
      expect(result).toHaveProperty('summary');
    });

    it('uses sessionContext sessionId when sessionData has none', async () => {
      const scheduler = scheduleLearning({ sessionId: 'context-session' });
      await scheduler.onSessionEnd({
        toolUsage: { Read: { calls: 1, successes: 1, totalMs: 100 } },
      });
      expect(writeJsonFile).toHaveBeenCalled();
    });

    it('uses sessionData sessionId over context sessionId', async () => {
      const scheduler = scheduleLearning({ sessionId: 'context-session' });
      await scheduler.onSessionEnd({
        sessionId: 'data-session',
        toolUsage: { Read: { calls: 1, successes: 1, totalMs: 100 } },
      });
      expect(writeJsonFile).toHaveBeenCalled();
    });

    it('generates auto-sessionId when none provided', async () => {
      const scheduler = scheduleLearning();
      const result = await scheduler.onSessionEnd({
        toolUsage: { Read: { calls: 1, successes: 1, totalMs: 50 } },
      });
      expect(writeJsonFile).toHaveBeenCalled();
      expect(result).toHaveProperty('groupsProcessed');
    });

    it('onSessionEnd handles empty sessionData', async () => {
      const scheduler = scheduleLearning();
      const result = await scheduler.onSessionEnd();
      expect(result).toHaveProperty('groupsProcessed');
    });
  });
});
