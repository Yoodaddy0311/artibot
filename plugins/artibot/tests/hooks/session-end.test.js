import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';

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
  createErrorHandler: vi.fn(() => (_err) => {}),
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
  let runMacroAutoRegister;
  let buildSessionData;
  let reportScoreHealth;

  beforeEach(async () => {
    vi.resetModules();
    mockState.readStdinResult = Promise.resolve('{}');
    mockState.atomicWriteSyncCalls = [];
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {});

    // Dynamically import to get a fresh module with runLearningPipeline
    const mod = await import('../../scripts/hooks/session-end.js');
    runLearningPipeline = mod.runLearningPipeline;
    runMacroAutoRegister = mod.runMacroAutoRegister;
    buildSessionData = mod.buildSessionData;
    reportScoreHealth = mod.reportScoreHealth;

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

  // ---------------------------------------------------------------------------
  // B1: macro-learner sweep integration
  // ---------------------------------------------------------------------------
  describe('runMacroAutoRegister()', () => {
    it('invokes sweepAutoRegister with pluginRoot + config', async () => {
      const sweep = vi.fn(async () => ({ registered: [], skipped: [] }));
      const result = await runMacroAutoRegister({
        pluginRoot: '/fake/root',
        config: { ago: { selfControl: { masterEnabled: true } } },
        sweepAutoRegister: sweep,
      });
      expect(sweep).toHaveBeenCalledWith({
        pluginRoot: '/fake/root',
        config: expect.objectContaining({ ago: expect.anything() }),
      });
      expect(result.registered).toBe(0);
    });

    it('emits stderr marker when macros are registered', async () => {
      const sweep = vi.fn(async () => ({
        registered: [{ id: 's1', macroId: 'm_1' }, { id: 's2', macroId: 'm_2' }],
        skipped: [],
      }));
      stderrSpy.mockClear();
      const result = await runMacroAutoRegister({
        pluginRoot: '/fake/root',
        config: {},
        sweepAutoRegister: sweep,
      });
      expect(result.registered).toBe(2);
      const wrote = stderrSpy.mock.calls.some((c) =>
        typeof c[0] === 'string' && c[0].includes('macros-auto-registered count=2'),
      );
      expect(wrote).toBe(true);
    });

    it('stays silent when no macros are registered', async () => {
      const sweep = vi.fn(async () => ({ registered: [], skipped: [{ id: 'a', reason: 'low-confidence' }] }));
      stderrSpy.mockClear();
      await runMacroAutoRegister({ pluginRoot: '/fake/root', config: {}, sweepAutoRegister: sweep });
      const wrote = stderrSpy.mock.calls.some((c) =>
        typeof c[0] === 'string' && c[0].includes('macros-auto-registered'),
      );
      expect(wrote).toBe(false);
    });

    it('handles missing registered array gracefully', async () => {
      const sweep = vi.fn(async () => ({ reason: 'master-disabled' }));
      const result = await runMacroAutoRegister({
        pluginRoot: '/fake/root',
        config: { ago: { selfControl: { masterEnabled: false } } },
        sweepAutoRegister: sweep,
      });
      expect(result.registered).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // WP-D: session signals reach the learning pipeline
  // ---------------------------------------------------------------------------
  describe('buildSessionData()', () => {
    it('carries a signals field into the pipeline payload', async () => {
      // The whole defect was that nothing measurable reached the scorer. The
      // key existing is the minimum bar; the values are covered by the
      // session-signals and pipeline suites.
      const data = await buildSessionData({ session_id: 's1', transcript_path: '/nope.jsonl' });
      expect(data).toHaveProperty('signals');
    });

    it('survives signal extraction failure without throwing', async () => {
      // getPluginRoot is mocked to a path with no modules, so the dynamic
      // import inside signal extraction genuinely fails here. Instrumentation
      // must never be the reason a session cannot end.
      const data = await buildSessionData({ session_id: 's2', transcript_path: '/nope.jsonl' });
      expect(data.signals).toBeNull();
      expect(data.sessionId).toBe('s2');
    });

    it('tolerates a payload with no transcript_path at all', async () => {
      const data = await buildSessionData({ session_id: 's3' });
      expect(data.sessionId).toBe('s3');
      expect(data).toHaveProperty('signals');
    });

    it('still forwards completed_tasks for other consumers', async () => {
      // Scoring no longer depends on it, but it is deliberately not removed:
      // a future payload may populate it, and inputsPresent records arrival.
      const data = await buildSessionData({ session_id: 's4', completed_tasks: [{ id: 't1' }] });
      expect(data.completedTasks).toEqual([{ id: 't1' }]);
    });

    it('defaults completed_tasks to an empty array when absent', async () => {
      const data = await buildSessionData({ session_id: 's5' });
      expect(data.completedTasks).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // WP-D: score-health verdict is surfaced on stderr (PRD §5.2 B-3 / AC-4)
  // ---------------------------------------------------------------------------
  describe('reportScoreHealth()', () => {
    /** Pull the emitted score-health line out of the stderr spy. */
    function healthLine() {
      const call = stderrSpy.mock.calls.find(
        (c) => typeof c[0] === 'string' && c[0].includes('[learning] score health:'),
      );
      return call?.[0];
    }

    it('prints the verdict line for a healthy store', async () => {
      stderrSpy.mockClear();
      await reportScoreHealth({
        getScoreHealth: async () => ({
          samples: 40, distinctSignatures: 9, distinctByDimension: {},
          degenerate: false, reason: null, rubricVersion: 2,
          excludedByRubric: 0, unmeasured: 0,
        }),
      });
      expect(healthLine()).toBe(
        '[learning] score health: ok (samples=40, unmeasured=0, signatures=9, rubric v2)\n',
      );
    });

    it('prints DEGENERATE with the reason when the store has collapsed', async () => {
      stderrSpy.mockClear();
      await reportScoreHealth({
        getScoreHealth: async () => ({
          samples: 318, distinctSignatures: 1, distinctByDimension: {},
          degenerate: true, reason: 'constant dimension(s): efficiency',
          rubricVersion: 2, excludedByRubric: 0, unmeasured: 300,
        }),
      });
      const line = healthLine();
      expect(line).toContain('DEGENERATE — constant dimension(s): efficiency');
      // unmeasured separates "scoring broke" from "signals stopped arriving".
      expect(line).toContain('unmeasured=300');
      expect(line).toContain('samples=318');
    });

    it('surfaces the not-yet-judgeable verdict rather than implying health', async () => {
      stderrSpy.mockClear();
      await reportScoreHealth({
        getScoreHealth: async () => ({
          samples: 3, distinctSignatures: 2, distinctByDimension: {},
          degenerate: false, reason: 'insufficient_samples', rubricVersion: 2,
          excludedByRubric: 0, unmeasured: 0,
        }),
      });
      expect(healthLine()).toContain('insufficient_samples');
    });

    it('never lets a health-check failure escape into session teardown', async () => {
      stderrSpy.mockClear();
      await expect(reportScoreHealth({
        getScoreHealth: async () => { throw new Error('store unreadable'); },
      })).resolves.toBeUndefined();
      expect(healthLine()).toBeUndefined();
    });

    it('stays silent when the module cannot even be resolved', async () => {
      // getPluginRoot is mocked to a path with no modules, so this exercises the
      // real dynamic-import failure rather than a simulated one.
      stderrSpy.mockClear();
      await expect(reportScoreHealth()).resolves.toBeUndefined();
      expect(healthLine()).toBeUndefined();
    });

    it('emits a real verdict from the real store reader (isolated HOME)', async () => {
      // End-to-end through the actual degeneracy logic, pointed at a throwaway
      // store. AC-4 asks for the line to appear, not merely for the call to
      // happen — so this asserts on the emitted text.
      const { mkdirSync, writeFileSync } = await import('node:fs');
      const { getScoreHealth } = await import('../../lib/learning/score-health.js');
      const home = path.join(os.tmpdir(), `artibot-health-${Date.now()}`);
      mkdirSync(path.join(home, '.claude', 'artibot'), { recursive: true });
      // 12 identical rows: past the sample floor, one signature -> degenerate.
      const rows = Array.from({ length: 12 }, (_, i) => ({
        id: `e${i}`, rubricVersion: 2,
        dimensions: {
          accuracy: { score: 1 }, completeness: { score: 3 },
          efficiency: { score: 3 }, satisfaction: { score: 2 },
        },
      }));
      writeFileSync(
        path.join(home, '.claude', 'artibot', 'evaluations.json'),
        JSON.stringify(rows), 'utf-8',
      );

      const prev = process.env.USERPROFILE;
      process.env.USERPROFILE = home;
      stderrSpy.mockClear();
      try {
        await reportScoreHealth({ getScoreHealth });
      } finally {
        process.env.USERPROFILE = prev;
      }

      const line = healthLine();
      expect(line).toContain('[learning] score health: DEGENERATE');
      expect(line).toContain('samples=12');
      expect(line).toContain('signatures=1');
    });
  });
});
