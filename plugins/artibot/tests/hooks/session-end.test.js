import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Tests for the session-end hook's learning pipeline parallelization.
 * The runLearningPipeline function runs selfEvaluate and collectExperiences
 * in parallel, then batchLearn and hotSwap sequentially.
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
    function createMockLearningModule(overrides = {}) {
      return {
        getImprovementSuggestions: vi.fn(() => Promise.resolve({
          overallTrend: 'improving',
          weakDimensions: [],
          suggestions: ['Keep up the good work'],
        })),
        collectDailyExperiences: vi.fn(() => Promise.resolve([
          { id: 'exp-1', type: 'tool', category: 'Read' },
          { id: 'exp-2', type: 'success', category: 'task' },
        ])),
        batchLearn: vi.fn(() => Promise.resolve({
          groupsProcessed: 2,
          patternsExtracted: 1,
          patterns: [{ key: 'tool::Read', confidence: 0.9 }],
        })),
        hotSwap: vi.fn(() => Promise.resolve({
          promoted: [{ patternKey: 'tool::Read' }],
          demoted: [],
        })),
        ...overrides,
      };
    }

    const sessionData = {
      sessionId: 'test-session-1',
      toolUsage: { Read: { calls: 10, successes: 9, totalMs: 500 } },
      errors: [],
      completedTasks: [],
    };

    it('runs selfEvaluate and collectExperiences concurrently', async () => {
      let evalStarted = false;
      let collectStarted = false;

      const mockModule = createMockLearningModule({
        getImprovementSuggestions: vi.fn(() => {
          evalStarted = true;
          return new Promise((resolve) => {
            setTimeout(() => resolve({ overallTrend: 'stable' }), 10);
          });
        }),
        collectDailyExperiences: vi.fn(() => {
          collectStarted = true;
          // Both should be started before either resolves
          expect(evalStarted).toBe(true);
          return Promise.resolve([{ id: 'exp-1' }]);
        }),
      });

      await runLearningPipeline(sessionData, mockModule);

      expect(evalStarted).toBe(true);
      expect(collectStarted).toBe(true);
    });

    it('calls batchLearn after collectExperiences completes', async () => {
      const callOrder = [];

      const mockModule = createMockLearningModule({
        collectDailyExperiences: vi.fn(() => {
          callOrder.push('collectExperiences');
          return Promise.resolve([{ id: 'exp-1' }]);
        }),
        batchLearn: vi.fn(() => {
          callOrder.push('batchLearn');
          return Promise.resolve({ groupsProcessed: 1, patternsExtracted: 0 });
        }),
        hotSwap: vi.fn(() => {
          callOrder.push('hotSwap');
          return Promise.resolve({ promoted: [], demoted: [] });
        }),
      });

      await runLearningPipeline(sessionData, mockModule);

      const collectIdx = callOrder.indexOf('collectExperiences');
      const batchIdx = callOrder.indexOf('batchLearn');
      const hotSwapIdx = callOrder.indexOf('hotSwap');

      expect(collectIdx).toBeLessThan(batchIdx);
      expect(batchIdx).toBeLessThan(hotSwapIdx);
    });

    it('calls hotSwap after batchLearn completes', async () => {
      const callOrder = [];

      const mockModule = createMockLearningModule({
        batchLearn: vi.fn(() => {
          callOrder.push('batchLearn');
          return Promise.resolve({ groupsProcessed: 1 });
        }),
        hotSwap: vi.fn(() => {
          callOrder.push('hotSwap');
          return Promise.resolve({ promoted: [] });
        }),
      });

      await runLearningPipeline(sessionData, mockModule);

      expect(callOrder.indexOf('batchLearn')).toBeLessThan(callOrder.indexOf('hotSwap'));
    });

    it('passes experiences to batchLearn', async () => {
      const expectedExperiences = [{ id: 'exp-1' }, { id: 'exp-2' }];

      const mockModule = createMockLearningModule({
        collectDailyExperiences: vi.fn(() => Promise.resolve(expectedExperiences)),
      });

      await runLearningPipeline(sessionData, mockModule);

      expect(mockModule.batchLearn).toHaveBeenCalledWith(expectedExperiences);
    });

    it('passes learned result to hotSwap', async () => {
      const learnedResult = { groupsProcessed: 3, patternsExtracted: 2 };

      const mockModule = createMockLearningModule({
        batchLearn: vi.fn(() => Promise.resolve(learnedResult)),
      });

      await runLearningPipeline(sessionData, mockModule);

      expect(mockModule.hotSwap).toHaveBeenCalledWith(learnedResult);
    });

    it('returns all pipeline results', async () => {
      const mockModule = createMockLearningModule();

      const result = await runLearningPipeline(sessionData, mockModule);

      expect(result).toHaveProperty('evalResult');
      expect(result).toHaveProperty('experiences');
      expect(result).toHaveProperty('learned');
      expect(result).toHaveProperty('hotSwapped');
      expect(result.evalResult).toHaveProperty('overallTrend');
      expect(result.experiences).toHaveLength(2);
      expect(result.learned.groupsProcessed).toBe(2);
      expect(result.hotSwapped.promoted).toHaveLength(1);
    });

    // -----------------------------------------------------------------------
    // Error handling tests
    // -----------------------------------------------------------------------

    it('handles selfEvaluate failure gracefully', async () => {
      const mockModule = createMockLearningModule({
        getImprovementSuggestions: vi.fn(() => Promise.reject(new Error('eval failed'))),
      });

      const result = await runLearningPipeline(sessionData, mockModule);

      expect(result.evalResult).toBeNull();
      expect(result.experiences).not.toBeNull();
      expect(mockModule.batchLearn).toHaveBeenCalled();
      expect(mockModule.hotSwap).toHaveBeenCalled();
    });

    it('handles collectExperiences failure gracefully', async () => {
      const mockModule = createMockLearningModule({
        collectDailyExperiences: vi.fn(() => Promise.reject(new Error('collect failed'))),
      });

      const result = await runLearningPipeline(sessionData, mockModule);

      expect(result.experiences).toBeNull();
      expect(result.evalResult).not.toBeNull();
      expect(mockModule.batchLearn).toHaveBeenCalledWith(null);
    });

    it('handles batchLearn failure gracefully', async () => {
      const mockModule = createMockLearningModule({
        batchLearn: vi.fn(() => Promise.reject(new Error('learn failed'))),
      });

      const result = await runLearningPipeline(sessionData, mockModule);

      expect(result.learned).toBeNull();
      expect(mockModule.hotSwap).toHaveBeenCalledWith(null);
    });

    it('handles hotSwap failure gracefully', async () => {
      const mockModule = createMockLearningModule({
        hotSwap: vi.fn(() => Promise.reject(new Error('swap failed'))),
      });

      const result = await runLearningPipeline(sessionData, mockModule);

      expect(result.hotSwapped).toBeNull();
      expect(result.evalResult).not.toBeNull();
      expect(result.experiences).not.toBeNull();
      expect(result.learned).not.toBeNull();
    });

    it('handles both parallel branches failing', async () => {
      const mockModule = createMockLearningModule({
        getImprovementSuggestions: vi.fn(() => Promise.reject(new Error('eval failed'))),
        collectDailyExperiences: vi.fn(() => Promise.reject(new Error('collect failed'))),
      });

      const result = await runLearningPipeline(sessionData, mockModule);

      expect(result.evalResult).toBeNull();
      expect(result.experiences).toBeNull();
      expect(mockModule.batchLearn).toHaveBeenCalledWith(null);
      expect(mockModule.hotSwap).toHaveBeenCalled();
    });

    it('logs error to stderr when selfEvaluate fails', async () => {
      stderrSpy.mockClear();
      const mockModule = createMockLearningModule({
        getImprovementSuggestions: vi.fn(() => Promise.reject(new Error('eval boom'))),
      });

      await runLearningPipeline(sessionData, mockModule);

      const stderrOutput = stderrSpy.mock.calls.map((c) => c[0]).join('');
      expect(stderrOutput).toContain('selfEvaluate failed');
      expect(stderrOutput).toContain('eval boom');
    });

    it('logs error to stderr when batchLearn fails', async () => {
      stderrSpy.mockClear();
      const mockModule = createMockLearningModule({
        batchLearn: vi.fn(() => Promise.reject(new Error('learn boom'))),
      });

      await runLearningPipeline(sessionData, mockModule);

      const stderrOutput = stderrSpy.mock.calls.map((c) => c[0]).join('');
      expect(stderrOutput).toContain('batchLearn failed');
      expect(stderrOutput).toContain('learn boom');
    });

    it('logs error to stderr when hotSwap fails', async () => {
      stderrSpy.mockClear();
      const mockModule = createMockLearningModule({
        hotSwap: vi.fn(() => Promise.reject(new Error('swap boom'))),
      });

      await runLearningPipeline(sessionData, mockModule);

      const stderrOutput = stderrSpy.mock.calls.map((c) => c[0]).join('');
      expect(stderrOutput).toContain('hotSwap failed');
      expect(stderrOutput).toContain('swap boom');
    });
  });
});
