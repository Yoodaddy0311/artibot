import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Tests for the session-end hook's learning pipeline.
 * The runLearningPipeline function delegates to shutdownLearning()
 * which handles: summarize -> self-evaluate -> batch learn -> hot-swap.
 */

// ---------------------------------------------------------------------------
// Shared mock state container - survives vi.resetModules()
// ---------------------------------------------------------------------------
const mockState = {
  readStdinResult: Promise.resolve('{}'),
  atomicWriteSyncCalls: [],
};

vi.mock('../../scripts/utils/index.js', () => ({
  readStdin: vi.fn(() => mockState.readStdinResult),
  parseJSON: vi.fn((str) => {
    try { return JSON.parse(str); }
    catch { return null; }
  }),
  atomicWriteSync: vi.fn((...args) => { mockState.atomicWriteSyncCalls.push(args); }),
  getPluginRoot: vi.fn(() => '/fake/plugin/root'),
  toFileUrl: vi.fn((p) => `file://${p}`),
}));

vi.mock('../../lib/core/hook-utils.js', () => ({
  logHookError: vi.fn(),
  getStatePath: vi.fn(() => '/fake/.claude/artibot-state.json'),
  createErrorHandler: vi.fn(() => (err) => {}),
  hasExtension: vi.fn(() => false),
  extractFilePath: vi.fn(() => ''),
  extractToolName: vi.fn(() => ''),
  extractAgentId: vi.fn(() => 'unknown'),
  extractAgentRole: vi.fn(() => 'teammate'),
  normalizePath: vi.fn((p) => p),
  isSkippablePath: vi.fn(() => false),
  matchesPathPattern: vi.fn(() => false),
  getHomeDir: vi.fn(() => '/fake/home'),
  getClaudeDir: vi.fn(() => '/fake/home/.claude'),
  getArtibotDataDir: vi.fn(() => '/fake/home/.claude/artibot'),
  isEnvEnabled: vi.fn(() => false),
}));

describe('session-end hook - learning pipeline', () => {
  let stderrSpy;
  let exitSpy;
  let runLearningPipeline;

  beforeEach(async () => {
    vi.resetModules();
    mockState.readStdinResult = Promise.resolve('{}');
    mockState.atomicWriteSyncCalls = [];
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {});

    // Dynamically import to get a fresh module with runLearningPipeline
    const mod = await import('../../scripts/hooks/session-end.js');
    runLearningPipeline = mod.runLearningPipeline;

    // Allow the main() side-effect to complete
    await new Promise((r) => setTimeout(r, 100));
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
  });

  // ---------------------------------------------------------------------------
  describe('runLearningPipeline()', () => {
    const sessionData = {
      sessionId: 'test-session-1',
      toolUsage: { Read: { calls: 10, successes: 9, totalMs: 500 } },
      errors: [],
      completedTasks: [],
    };

    it('delegates to shutdownLearning with sessionData', async () => {
      const shutdownLearning = vi.fn(() => Promise.resolve({
        summarized: true,
        evaluated: { overallTrend: 'improving' },
        learned: { groupsProcessed: 2, patternsExtracted: 1 },
        hotSwapped: { promoted: [], demoted: [] },
      }));

      const mockModule = { shutdownLearning };

      await runLearningPipeline(sessionData, mockModule);

      expect(shutdownLearning).toHaveBeenCalledWith(sessionData);
      expect(shutdownLearning).toHaveBeenCalledTimes(1);
    });

    it('returns the result from shutdownLearning', async () => {
      const expectedResult = {
        summarized: true,
        evaluated: { overallTrend: 'stable' },
        learned: { groupsProcessed: 3, patternsExtracted: 2 },
        hotSwapped: { promoted: ['tool::Read'], demoted: [] },
      };

      const mockModule = {
        shutdownLearning: vi.fn(() => Promise.resolve(expectedResult)),
      };

      const result = await runLearningPipeline(sessionData, mockModule);

      expect(result).toEqual(expectedResult);
    });

    it('returns result with summarized=true when session is processed', async () => {
      const mockModule = {
        shutdownLearning: vi.fn(() => Promise.resolve({
          summarized: true,
          evaluated: null,
          learned: null,
          hotSwapped: null,
        })),
      };

      const result = await runLearningPipeline(sessionData, mockModule);

      expect(result.summarized).toBe(true);
    });

    it('returns result with evaluated data when self-evaluation succeeds', async () => {
      const evalResult = {
        overallTrend: 'improving',
        weakDimensions: ['speed'],
        suggestions: ['Optimize tool usage'],
      };

      const mockModule = {
        shutdownLearning: vi.fn(() => Promise.resolve({
          summarized: true,
          evaluated: evalResult,
          learned: null,
          hotSwapped: null,
        })),
      };

      const result = await runLearningPipeline(sessionData, mockModule);

      expect(result.evaluated).toEqual(evalResult);
      expect(result.evaluated.overallTrend).toBe('improving');
    });

    it('returns learned result with groups and patterns', async () => {
      const mockModule = {
        shutdownLearning: vi.fn(() => Promise.resolve({
          summarized: true,
          evaluated: null,
          learned: { groupsProcessed: 5, patternsExtracted: 3 },
          hotSwapped: null,
        })),
      };

      const result = await runLearningPipeline(sessionData, mockModule);

      expect(result.learned.groupsProcessed).toBe(5);
      expect(result.learned.patternsExtracted).toBe(3);
    });

    it('returns hotSwapped result with promoted and demoted', async () => {
      const mockModule = {
        shutdownLearning: vi.fn(() => Promise.resolve({
          summarized: true,
          evaluated: null,
          learned: null,
          hotSwapped: { promoted: ['tool::Read', 'tool::Grep'], demoted: ['tool::Bash'] },
        })),
      };

      const result = await runLearningPipeline(sessionData, mockModule);

      expect(result.hotSwapped.promoted).toHaveLength(2);
      expect(result.hotSwapped.demoted).toHaveLength(1);
    });

    it('returns all pipeline results populated', async () => {
      const mockModule = {
        shutdownLearning: vi.fn(() => Promise.resolve({
          summarized: true,
          evaluated: { overallTrend: 'improving' },
          learned: { groupsProcessed: 2, patternsExtracted: 1 },
          hotSwapped: { promoted: ['tool::Read'], demoted: [] },
        })),
      };

      const result = await runLearningPipeline(sessionData, mockModule);

      expect(result).toHaveProperty('summarized');
      expect(result).toHaveProperty('evaluated');
      expect(result).toHaveProperty('learned');
      expect(result).toHaveProperty('hotSwapped');
      expect(result.summarized).toBe(true);
      expect(result.evaluated).not.toBeNull();
      expect(result.learned).not.toBeNull();
      expect(result.hotSwapped).not.toBeNull();
    });

    // -----------------------------------------------------------------------
    // Error handling tests
    // -----------------------------------------------------------------------

    it('handles shutdownLearning returning null evaluated gracefully', async () => {
      const mockModule = {
        shutdownLearning: vi.fn(() => Promise.resolve({
          summarized: true,
          evaluated: null,
          learned: { groupsProcessed: 1, patternsExtracted: 0 },
          hotSwapped: { promoted: [], demoted: [] },
        })),
      };

      const result = await runLearningPipeline(sessionData, mockModule);

      expect(result.evaluated).toBeNull();
      expect(result.learned).not.toBeNull();
      expect(result.hotSwapped).not.toBeNull();
    });

    it('handles shutdownLearning returning null learned gracefully', async () => {
      const mockModule = {
        shutdownLearning: vi.fn(() => Promise.resolve({
          summarized: true,
          evaluated: { overallTrend: 'stable' },
          learned: null,
          hotSwapped: null,
        })),
      };

      const result = await runLearningPipeline(sessionData, mockModule);

      expect(result.learned).toBeNull();
      expect(result.evaluated).not.toBeNull();
    });

    it('handles shutdownLearning returning null hotSwapped gracefully', async () => {
      const mockModule = {
        shutdownLearning: vi.fn(() => Promise.resolve({
          summarized: true,
          evaluated: null,
          learned: { groupsProcessed: 0, patternsExtracted: 0 },
          hotSwapped: null,
        })),
      };

      const result = await runLearningPipeline(sessionData, mockModule);

      expect(result.hotSwapped).toBeNull();
      expect(result.learned).not.toBeNull();
    });

    it('handles shutdownLearning returning all nulls gracefully', async () => {
      const mockModule = {
        shutdownLearning: vi.fn(() => Promise.resolve({
          summarized: false,
          evaluated: null,
          learned: null,
          hotSwapped: null,
        })),
      };

      const result = await runLearningPipeline(sessionData, mockModule);

      expect(result.summarized).toBe(false);
      expect(result.evaluated).toBeNull();
      expect(result.learned).toBeNull();
      expect(result.hotSwapped).toBeNull();
    });

    it('propagates shutdownLearning rejection', async () => {
      const mockModule = {
        shutdownLearning: vi.fn(() => Promise.reject(new Error('shutdown failed'))),
      };

      await expect(runLearningPipeline(sessionData, mockModule))
        .rejects.toThrow('shutdown failed');
    });

    it('passes sessionData unchanged to shutdownLearning', async () => {
      const customSessionData = {
        sessionId: 'custom-session',
        toolUsage: { Write: { calls: 5, successes: 5, totalMs: 200 } },
        errors: [{ message: 'test error', code: 'E001' }],
        completedTasks: [{ id: 'task-1', type: 'implementation' }],
        teamConfig: { pattern: 'squad', size: 3 },
      };

      const mockModule = {
        shutdownLearning: vi.fn(() => Promise.resolve({
          summarized: true,
          evaluated: null,
          learned: null,
          hotSwapped: null,
        })),
      };

      await runLearningPipeline(customSessionData, mockModule);

      expect(mockModule.shutdownLearning).toHaveBeenCalledWith(customSessionData);
    });

    it('works when shutdownLearning returns minimal result', async () => {
      const mockModule = {
        shutdownLearning: vi.fn(() => Promise.resolve({
          summarized: true,
          evaluated: null,
          learned: null,
          hotSwapped: null,
        })),
      };

      const result = await runLearningPipeline(sessionData, mockModule);

      expect(result).toBeDefined();
      expect(result.summarized).toBe(true);
    });
  });
});
