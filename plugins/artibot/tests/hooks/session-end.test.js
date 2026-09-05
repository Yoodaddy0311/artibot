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
  let recordUsageReceipts;

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
    recordUsageReceipts = mod.recordUsageReceipts;

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

  // ---------------------------------------------------------------------------
  // usage.receipt ledger writer
  //
  // The defect this covers is that `usage.receipt` had ZERO writers: the
  // receipt builder existed and nothing ever appended its output. So the two
  // things worth proving are that a real session produces real ledger lines,
  // and that running the hook twice does NOT produce them twice —
  // `lib/runtime/ledger.js#foldMissions` sums usage.receipt into
  // `economics`, so a re-fire without dedupe silently doubles recorded spend.
  //
  // WHAT A GREEN RUN HERE DOES NOT PROVE: that the hook is wired into main().
  // These tests call `recordUsageReceipts` directly because the module's
  // `isMainEntry` guard stops main() from running under vitest. Live firing is
  // verified outside this suite.
  // ---------------------------------------------------------------------------
  describe('recordUsageReceipts()', () => {
    /** tmp roots created by a test, removed in afterEach. */
    let tmpRoots = [];

    afterEach(async () => {
      const { rmSync } = await import('node:fs');
      for (const dir of tmpRoots) {
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
      }
      tmpRoots = [];
    });

    /** Every stderr write that is the economics summary line. */
    function economicsLines() {
      return stderrSpy.mock.calls
        .map((c) => c[0])
        .filter((s) => typeof s === 'string' && s.startsWith('[economics] usage.receipt:'));
    }

    /**
     * The contract is EXACTLY ONE summary line per call. Zero means the hook
     * ran silently and an operator cannot tell it from a hook that never
     * fired; more than one means a retry loop is being hidden.
     */
    function expectOneSummaryLine() {
      const lines = economicsLines();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(
        /^\[economics] usage\.receipt: status=\S+ appended=\d+ rejected=\d+ deduped=\d+ receipts=\d+ coverage=\S+ reason=/,
      );
    }

    /** The real collaborators, imported directly (getPluginRoot is mocked). */
    async function realDeps() {
      const [usage, envelope, ledger, root, mission] = await Promise.all([
        import('../../lib/economics/usage-receipt.js'),
        import('../../lib/economics/receipt-envelope.js'),
        import('../../lib/runtime/ledger.js'),
        import('../../lib/git/project-root.js'),
        import('../../lib/mission/mission-id.js'),
      ]);
      return {
        deps: {
          buildUsageReceipts: usage.buildUsageReceipts,
          toUsageReceiptEnvelopes: envelope.toUsageReceiptEnvelopes,
          appendLedgerEvent: ledger.appendLedgerEvent,
          readAllEvents: ledger.readAllEvents,
          resolveProjectRoot: root.resolveProjectRoot,
          sessionFallbackMissionId: mission.sessionFallbackMissionId,
          isMissionId: mission.isMissionId,
        },
        ledgerFilePath: ledger.ledgerFilePath,
        resolveProjectRoot: root.resolveProjectRoot,
      };
    }

    /** One assistant entry in the shape measured 2026-09-02. */
    function assistantEntry(requestId, minute, model = 'claude-opus-5') {
      return JSON.stringify({
        type: 'assistant',
        requestId,
        timestamp: `2026-09-02T06:${String(minute % 60).padStart(2, '0')}:00.000Z`,
        effort: 'high',
        message: {
          model,
          role: 'assistant',
          content: [{ type: 'text', text: 'x'.repeat(64) }],
          usage: {
            input_tokens: 1200,
            cache_read_input_tokens: 90000,
            cache_creation_input_tokens: 4500,
            output_tokens: 800,
            output_tokens_details: { thinking_tokens: 250 },
          },
        },
      });
    }

    /** Each response written twice, as real transcripts do. */
    function transcriptText(prefix, count) {
      const lines = [];
      for (let i = 0; i < count; i += 1) {
        const line = assistantEntry(`${prefix}-req-${i}`, i);
        lines.push(line);
        lines.push(line);
      }
      return `${lines.join('\n')}\n`;
    }

    /**
     * A throwaway project on the real filesystem: a `.git` marker so
     * `resolveProjectRoot` stops there, a main transcript of 700 distinct
     * responses (1400 rows), and three subagent transcripts of 110 each.
     *
     * @returns {Promise<{root: string, sessionId: string, transcriptPath: string,
     *   bytes: number, mainRows: number}>}
     */
    async function makeProject() {
      const { mkdirSync, writeFileSync, statSync } = await import('node:fs');
      const sessionId = `sess${Date.now()}${Math.floor(Math.random() * 1e6)}`;
      const root = path.join(os.tmpdir(), `artibot-receipt-${sessionId}`);
      tmpRoots.push(root);
      mkdirSync(path.join(root, '.git'), { recursive: true });

      const dir = path.join(root, 'transcripts');
      const transcriptPath = path.join(dir, `${sessionId}.jsonl`);
      const subDir = path.join(dir, sessionId, 'subagents');
      mkdirSync(subDir, { recursive: true });

      const mainText = transcriptText('main', 700);
      writeFileSync(transcriptPath, mainText, 'utf-8');
      let bytes = Buffer.byteLength(mainText, 'utf-8');
      for (const name of ['agent-aaa11111', 'agent-bbb22222', 'agent-ccc33333']) {
        const text = transcriptText(name, 110);
        writeFileSync(path.join(subDir, `${name}.jsonl`), text, 'utf-8');
        bytes += Buffer.byteLength(text, 'utf-8');
      }
      // Prove the fixture actually landed at size — a 0-byte write would make
      // every assertion below pass for the wrong reason.
      expect(statSync(transcriptPath).size).toBeGreaterThan(400_000);
      return {
        root,
        sessionId,
        transcriptPath,
        bytes,
        mainRows: mainText.trimEnd().split('\n').length,
      };
    }

    /** Ledger lines of one event kind. */
    async function ledgerLines(file, event) {
      const { readFileSync, existsSync } = await import('node:fs');
      if (!existsSync(file)) return [];
      return readFileSync(file, 'utf-8')
        .split('\n')
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l))
        .filter((e) => e.event === event);
    }

    /** A receipt shaped like the real builder's output. */
    function fakeReceipt(runId, missionId) {
      return {
        schema_version: 1,
        run_id: runId,
        mission_id: missionId,
        model_identity: {
          provider: 'anthropic',
          family: 'claude',
          tier: 'opus',
          model_id: 'claude-opus-5',
          version: 'claude-opus-5',
          catalog_version: '2026-09-02',
        },
        usage: {
          source: 'transcript',
          fresh_input_tokens: 10,
          cached_input_tokens: 20,
          cache_creation_tokens: 5,
          output_tokens: 3,
          requests: 1,
        },
        timing: {
          started_at: '2026-09-02T06:00:00.000Z',
          completed_at: '2026-09-02T06:01:00.000Z',
          latency_ms: 60000,
        },
        outcome: { status: 'unknown', accepted: null },
        cost: { total: null, pricing_version: 'unresolved' },
      };
    }

    // -----------------------------------------------------------------------
    // 1. Preconditions — every one is a skip, never an exception
    // -----------------------------------------------------------------------

    it.each([
      ['no-transcript', { session_id: 'sess-abcdef01', cwd: '/tmp/x' }],
      ['no-session-id', { transcript_path: '/tmp/t.jsonl', cwd: '/tmp/x' }],
      ['no-cwd', { session_id: 'sess-abcdef01', transcript_path: '/tmp/t.jsonl' }],
    ])('skips with reason %s rather than throwing', async (reason, hookData) => {
      stderrSpy.mockClear();
      const res = await recordUsageReceipts(hookData);
      expect(res.status).toBe('skipped');
      expect(res.reason).toBe(reason);
      expect(res.appended).toBe(0);
      expectOneSummaryLine();
    });

    it('returns the full result shape even on the earliest skip', async () => {
      // A caller must not have to branch on `undefined` for the counters.
      const res = await recordUsageReceipts({});
      expect(res).toMatchObject({
        status: 'skipped',
        appended: 0,
        rejected: 0,
        deduped: 0,
      });
      expect(res).toHaveProperty('receipts');
      expect(res).toHaveProperty('coverage');
    });

    it('never throws for a null or undefined payload', async () => {
      await expect(recordUsageReceipts(null)).resolves.toMatchObject({ status: 'skipped' });
      await expect(recordUsageReceipts(undefined)).resolves.toMatchObject({ status: 'skipped' });
    });

    // -----------------------------------------------------------------------
    // 2. End to end on the real filesystem, with the real collaborators
    // -----------------------------------------------------------------------

    it('appends one real ledger line per receipt from a full-size transcript', async () => {
      const project = await makeProject();
      const { deps, ledgerFilePath, resolveProjectRoot } = await realDeps();
      const hookData = {
        session_id: project.sessionId,
        transcript_path: project.transcriptPath,
        cwd: project.root,
      };

      stderrSpy.mockClear();
      const startedAt = Date.now();
      const res = await recordUsageReceipts(hookData, deps);
      const elapsedMs = Date.now() - startedAt;

      expect(res.status).toBe('appended');
      // main + three subagents.
      expect(res.appended).toBeGreaterThanOrEqual(4);
      expect(res.rejected).toBe(0);
      expect(res.deduped).toBe(0);
      expectOneSummaryLine();

      const file = ledgerFilePath(resolveProjectRoot(project.root));
      const written = await ledgerLines(file, 'usage.receipt');
      expect(written).toHaveLength(res.appended);

      for (const line of written) {
        // `estimate` would mean a required counter was missing, so this also
        // asserts the transcript was parsed rather than guessed at.
        expect(line.data.usage.source).toBe('transcript');
        // `hook` is the writer of the envelope; `data.usage.source` above is
        // the provenance of the NUMBERS. Two different `source` fields, two
        // different questions — asserting both keeps them from being
        // conflated.
        expect(line.source).toBe('hook');
        expect(line.session_id).toBe(project.sessionId);
        expect(line.data.mission_id).toBe(line.mission_id);
        expect(line.data.run_id).toBe(line.run_id);
      }

      // A rejected line means the writer refused the envelope — the exact
      // failure this whole lane exists to prevent, and invisible from `res`
      // alone if the reason string were ever swallowed.
      expect(await ledgerLines(file, 'ledger.rejected')).toHaveLength(0);

      // Budget is 10s; recorded so a regression in parse cost is visible.
      expect(elapsedMs).toBeLessThan(10_000);
    });

    // -----------------------------------------------------------------------
    // 3. Re-firing must not double-count
    // -----------------------------------------------------------------------

    it('records nothing on a second call for the same session', async () => {
      const project = await makeProject();
      const { deps, ledgerFilePath, resolveProjectRoot } = await realDeps();
      const hookData = {
        session_id: project.sessionId,
        transcript_path: project.transcriptPath,
        cwd: project.root,
      };
      const file = ledgerFilePath(resolveProjectRoot(project.root));

      const first = await recordUsageReceipts(hookData, deps);
      expect(first.status).toBe('appended');
      const afterFirst = await ledgerLines(file, 'usage.receipt');

      stderrSpy.mockClear();
      const second = await recordUsageReceipts(hookData, deps);

      expect(second.status).toBe('skipped');
      expect(second.reason).toBe('already-recorded');
      expect(second.appended).toBe(0);
      expect(second.deduped).toBe(first.appended);
      expectOneSummaryLine();

      // The actual double-count proof: the file did not grow.
      const afterSecond = await ledgerLines(file, 'usage.receipt');
      expect(afterSecond).toHaveLength(afterFirst.length);
      expect(await ledgerLines(file, 'ledger.rejected')).toHaveLength(0);
    });

    it('NEGATIVE CONTROL: the ledger DOES double when the dedupe lookup is blinded', async () => {
      // The test above asserts the file did not grow. On its own that is also
      // what a hook which appended nothing at all would produce, so it cannot
      // distinguish working dedupe from a broken writer. Here the same second
      // call runs with `readAllEvents` forced to return nothing — the one
      // input dedupe depends on — and the line count doubles.
      //
      // Without this, a regression that silently stopped appending would keep
      // the idempotency test green.
      const project = await makeProject();
      const { deps, ledgerFilePath, resolveProjectRoot } = await realDeps();
      const hookData = {
        session_id: project.sessionId,
        transcript_path: project.transcriptPath,
        cwd: project.root,
      };
      const file = ledgerFilePath(resolveProjectRoot(project.root));

      const first = await recordUsageReceipts(hookData, deps);
      expect(first.status).toBe('appended');
      expect(first.appended).toBeGreaterThanOrEqual(4);

      const blinded = await recordUsageReceipts(hookData, {
        ...deps,
        readAllEvents: () => [],
      });

      expect(blinded.status).toBe('appended');
      expect(blinded.deduped).toBe(0);
      const lines = await ledgerLines(file, 'usage.receipt');
      expect(lines).toHaveLength(first.appended * 2);
    });

    // -----------------------------------------------------------------------
    // 4. The writer refuses every envelope
    // -----------------------------------------------------------------------

    it('reports failed with the writer reason when every append is rejected', async () => {
      const { deps } = await realDeps();
      const missionId = 'M-20260905-001';
      const appendLedgerEvent = vi.fn(() => ({
        ok: false,
        reason: 'source-not-allowed:reviewer',
      }));

      stderrSpy.mockClear();
      const res = await recordUsageReceipts(
        { session_id: 'sess-abcdef01', transcript_path: '/tmp/t.jsonl', cwd: '/tmp/x', mission_id: missionId },
        {
          ...deps,
          buildUsageReceipts: async () => ({
            receipts: [fakeReceipt('run-a', missionId), fakeReceipt('run-b', missionId)],
            meta: { coverage: 1 },
          }),
          appendLedgerEvent,
          readAllEvents: () => [],
          resolveProjectRoot: () => '/tmp/x',
        },
      );

      expect(res.status).toBe('failed');
      expect(res.rejected).toBe(2);
      expect(res.receipts).toBe(2);
      expect(res.appended).toBe(0);
      expect(res.reason).toContain('source-not-allowed:reviewer');
      expect(appendLedgerEvent).toHaveBeenCalledTimes(2);
      expectOneSummaryLine();
    });

    // -----------------------------------------------------------------------
    // 5. The parser throws
    // -----------------------------------------------------------------------

    it('reports failed with parse-failed when the receipt builder throws', async () => {
      const { deps } = await realDeps();
      stderrSpy.mockClear();
      const res = await recordUsageReceipts(
        { session_id: 'sess-abcdef01', transcript_path: '/tmp/t.jsonl', cwd: '/tmp/x' },
        {
          ...deps,
          buildUsageReceipts: async () => { throw new Error('transcript exploded'); },
          readAllEvents: () => [],
          resolveProjectRoot: () => '/tmp/x',
        },
      );

      expect(res.status).toBe('failed');
      expect(res.reason).toMatch(/^parse-failed:/);
      expect(res.appended).toBe(0);
      expectOneSummaryLine();
    });

    it('skips with no-receipts when the transcript yields nothing', async () => {
      const { deps } = await realDeps();
      const res = await recordUsageReceipts(
        { session_id: 'sess-abcdef01', transcript_path: '/tmp/t.jsonl', cwd: '/tmp/x' },
        {
          ...deps,
          buildUsageReceipts: async () => ({ receipts: [], meta: { coverage: null } }),
          readAllEvents: () => [],
          resolveProjectRoot: () => '/tmp/x',
        },
      );
      expect(res.status).toBe('skipped');
      expect(res.reason).toBe('no-receipts');
    });

    it('skips with no-project-root when root resolution fails', async () => {
      const { deps } = await realDeps();
      const res = await recordUsageReceipts(
        { session_id: 'sess-abcdef01', transcript_path: '/tmp/t.jsonl', cwd: '/tmp/x' },
        { ...deps, resolveProjectRoot: () => { throw new Error('no root'); } },
      );
      expect(res.status).toBe('skipped');
      expect(res.reason).toBe('no-project-root');
    });

    it('skips with no-mission-id when the fallback issuer throws', async () => {
      const { deps } = await realDeps();
      const res = await recordUsageReceipts(
        { session_id: 'sess-abcdef01', transcript_path: '/tmp/t.jsonl', cwd: '/tmp/x' },
        {
          ...deps,
          sessionFallbackMissionId: () => { throw new TypeError('too short'); },
          resolveProjectRoot: () => '/tmp/x',
        },
      );
      expect(res.status).toBe('skipped');
      expect(res.reason).toBe('no-mission-id');
    });

    // -----------------------------------------------------------------------
    // 6. Fail-open when the collaborators cannot even be loaded
    // -----------------------------------------------------------------------

    it('fails open when no deps are injected and the dynamic import cannot resolve', async () => {
      // getPluginRoot is mocked to '/fake/plugin/root', so the module's own
      // dynamic import genuinely fails here. Instrumentation must never be the
      // reason a session cannot end.
      stderrSpy.mockClear();
      let res;
      await expect(
        (async () => {
          res = await recordUsageReceipts({
            session_id: 'sess-abcdef01',
            transcript_path: '/tmp/t.jsonl',
            cwd: '/tmp/x',
          });
        })(),
      ).resolves.toBeUndefined();
      expect(res.status).toBe('failed');
      expect(res.appended).toBe(0);
      expectOneSummaryLine();
    });

    // -----------------------------------------------------------------------
    // 7. Mission id: declared wins, otherwise the session fallback
    // -----------------------------------------------------------------------

    /** Capture the missionId the hook hands the receipt builder. */
    async function capturedMissionId(hookData) {
      const { deps } = await realDeps();
      let seen = null;
      await recordUsageReceipts(hookData, {
        ...deps,
        buildUsageReceipts: async (opts) => {
          seen = opts.missionId;
          return { receipts: [], meta: { coverage: null } };
        },
        readAllEvents: () => [],
        resolveProjectRoot: () => '/tmp/x',
      });
      return seen;
    }

    it('uses the payload mission_id when it is a valid id', async () => {
      const seen = await capturedMissionId({
        session_id: 'sess-abcdef01',
        transcript_path: '/tmp/t.jsonl',
        cwd: '/tmp/x',
        mission_id: 'M-20260905-001',
      });
      expect(seen).toBe('M-20260905-001');
    });

    it('falls back to the session-derived id when the payload declares none', async () => {
      const seen = await capturedMissionId({
        session_id: 'sess-abcdef01',
        transcript_path: '/tmp/t.jsonl',
        cwd: '/tmp/x',
      });
      expect(seen).toMatch(/^M-\d{8}-S[0-9A-Za-z]{8}$/);
    });

    it('ignores a malformed payload mission_id rather than passing it through', async () => {
      // A fabricated mission id poisons every aggregate built on the receipt,
      // so an unparseable one must be replaced, never forwarded.
      const seen = await capturedMissionId({
        session_id: 'sess-abcdef01',
        transcript_path: '/tmp/t.jsonl',
        cwd: '/tmp/x',
        mission_id: 'not-a-mission-id',
      });
      expect(seen).not.toBe('not-a-mission-id');
      expect(seen).toMatch(/^M-\d{8}-S[0-9A-Za-z]{8}$/);
    });
  });
});
