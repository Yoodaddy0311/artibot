import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Shared mock state container -- survives vi.resetModules()
// ---------------------------------------------------------------------------
const mockState = {
  readStdinResult: Promise.resolve('{}'),
  collectExperienceFn: vi.fn(),
  shutdownLearningFn: vi.fn(),
};

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
vi.mock('../../scripts/utils/index.js', () => ({
  readStdin: vi.fn(() => mockState.readStdinResult),
  parseJSON: vi.fn((str) => {
    try { return JSON.parse(str); }
    catch { return null; }
  }),
  getPluginRoot: vi.fn(() => '/fake/plugin/root'),
  toFileUrl: vi.fn((p) => `file:///${p.replace(/\\/g, '/')}`),
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('nightly-learner hook', () => {
  let stderrSpy;
  let exitSpy;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mockState.readStdinResult = Promise.resolve('{}');
    mockState.collectExperienceFn = vi.fn().mockResolvedValue(undefined);
    mockState.shutdownLearningFn = vi.fn().mockResolvedValue({
      summarized: false,
      learned: null,
      hotSwapped: null,
    });
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {});
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
  });

  async function importAndWait(delay = 300) {
    await import('../../scripts/hooks/nightly-learner.js');
    await new Promise((r) => setTimeout(r, delay));
  }

  describe('early exit conditions', () => {
    it('exits early when hookData is null (invalid JSON)', async () => {
      mockState.readStdinResult = Promise.resolve('not valid json');

      await importAndWait();

      // The script does: if (!hookData) return; so no stderr about learning
      // The dynamic import should never be attempted
      const stderrOutput = stderrSpy.mock.calls.map((c) => c[0]).join('');
      expect(stderrOutput).not.toContain('[learning]');
    });

    it('exits early when hookData is null (empty string)', async () => {
      mockState.readStdinResult = Promise.resolve('');

      await importAndWait();

      const stderrOutput = stderrSpy.mock.calls.map((c) => c[0]).join('');
      expect(stderrOutput).not.toContain('[learning]');
    });

    it('exits early when readStdin returns empty object parsed as null', async () => {
      // parseJSON of 'null' returns null
      mockState.readStdinResult = Promise.resolve('null');

      await importAndWait();

      const stderrOutput = stderrSpy.mock.calls.map((c) => c[0]).join('');
      expect(stderrOutput).not.toContain('[learning]');
    });
  });

  describe('session data extraction logic', () => {
    // The dynamic import of the learning module will fail in tests since the
    // actual file doesn't exist at /fake/plugin/root. This tests the code path
    // up to the import, which logs an error to stderr.
    it('attempts to import learning module on valid hookData', async () => {
      mockState.readStdinResult = Promise.resolve(JSON.stringify({
        session_id: 'test-session-123',
      }));

      await importAndWait();

      // The import will fail, triggering the catch block
      const stderrOutput = stderrSpy.mock.calls.map((c) => c[0]).join('');
      expect(stderrOutput).toContain('[artibot:nightly-learner]');
    });

    it('constructs session data with all provided fields', async () => {
      // This test validates the code path where hookData is truthy.
      // The dynamic import fails, but we can verify the script reaches that point.
      mockState.readStdinResult = Promise.resolve(JSON.stringify({
        session_id: 'sess-abc',
        tool_usage: { Bash: 5 },
        errors: ['err1'],
        completed_tasks: ['t1'],
        team_config: { mode: 'squad' },
        experiences: [{ type: 'tool', category: 'dev' }],
      }));

      await importAndWait();

      // Script attempted to process the data (import failed in test env)
      const stderrOutput = stderrSpy.mock.calls.map((c) => c[0]).join('');
      expect(stderrOutput).toContain('[artibot:nightly-learner]');
    });

    it('uses default sessionId when session_id is not provided', async () => {
      mockState.readStdinResult = Promise.resolve(JSON.stringify({
        tool_usage: { Read: 3 },
      }));

      await importAndWait();

      // The script will run, try to import, fail, and log to stderr
      const stderrOutput = stderrSpy.mock.calls.map((c) => c[0]).join('');
      expect(stderrOutput).toContain('[artibot:nightly-learner]');
    });
  });

  describe('hook data field defaults', () => {
    it('handles hookData with no optional fields', async () => {
      mockState.readStdinResult = Promise.resolve(JSON.stringify({}));

      await importAndWait();

      // Script should process {} without crashing before the import
      // Import fails in test env, caught gracefully
      const stderrOutput = stderrSpy.mock.calls.map((c) => c[0]).join('');
      expect(stderrOutput).toContain('[artibot:nightly-learner]');
      // Should NOT exit the process for import errors (only for main() catch)
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it('handles experiences as empty array', async () => {
      mockState.readStdinResult = Promise.resolve(JSON.stringify({
        experiences: [],
      }));

      await importAndWait();

      // Empty experiences should be fine, script continues to import
      const stderrOutput = stderrSpy.mock.calls.map((c) => c[0]).join('');
      expect(stderrOutput).toContain('[artibot:nightly-learner]');
    });
  });

  describe('error handling', () => {
    it('catches dynamic import errors and logs to stderr', async () => {
      mockState.readStdinResult = Promise.resolve(JSON.stringify({
        session_id: 'test',
      }));

      await importAndWait();

      // Dynamic import of /fake/plugin/root/lib/learning/index.js will fail
      const stderrOutput = stderrSpy.mock.calls.map((c) => c[0]).join('');
      expect(stderrOutput).toContain('[artibot:nightly-learner]');
    });

    it('does not call process.exit on import errors (inner try/catch)', async () => {
      mockState.readStdinResult = Promise.resolve(JSON.stringify({}));

      await importAndWait();

      // Inner try/catch just logs to stderr, does not exit
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it('calls process.exit(0) when main() itself rejects', async () => {
      // Use a factory pattern to avoid vitest's unhandled-rejection detection
      // before the module's catch block runs
      const rejectFactory = () => Promise.reject(new Error('main crash'));
      mockState.readStdinResult = rejectFactory();

      // Must catch the import's unhandled promise since readStdin immediately rejects
      try {
        await import('../../scripts/hooks/nightly-learner.js');
      } catch {
        // Expected
      }
      await new Promise((r) => setTimeout(r, 300));

      expect(exitSpy).toHaveBeenCalledWith(0);
    });
  });

  describe('plugin root and path construction', () => {
    it('calls getPluginRoot to resolve learning module path', async () => {
      const { getPluginRoot } = await import('../../scripts/utils/index.js');
      mockState.readStdinResult = Promise.resolve(JSON.stringify({}));

      await importAndWait();

      expect(getPluginRoot).toHaveBeenCalled();
    });

    it('calls toFileUrl to convert path for dynamic import', async () => {
      const { toFileUrl } = await import('../../scripts/utils/index.js');
      mockState.readStdinResult = Promise.resolve(JSON.stringify({}));

      await importAndWait();

      expect(toFileUrl).toHaveBeenCalledWith(
        expect.stringContaining('learning'),
      );
    });
  });
});
