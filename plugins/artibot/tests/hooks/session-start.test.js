import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * session-start.js initializes the Artibot plugin on every Claude Code session.
 * The `home` variable is defined at function scope (line 36), so the script
 * completes successfully and calls writeStdout with a welcome message.
 */

// ---------------------------------------------------------------------------
// Shared mock state container — survives vi.resetModules()
// ---------------------------------------------------------------------------
const mockState = {
  readStdinResult: Promise.resolve('{}'),
  writeStdoutCalls: [],
  readFileSyncImpl: () => { throw new Error('ENOENT'); },
  existsSyncResult: false,
  // checkForUpdateFactory is called on each invocation, returning a fresh Promise.
  // Using a factory (thunk) avoids storing a rejected Promise in state, which would
  // trigger vitest's unhandled-rejection detection before the module's catch block runs.
  checkForUpdateFactory: () => Promise.resolve({ hasUpdate: false }),
};

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
vi.mock('../../scripts/utils/index.js', () => ({
  readStdin: vi.fn(() => mockState.readStdinResult),
  writeStdout: vi.fn((...args) => { mockState.writeStdoutCalls.push(args); }),
  parseJSON: vi.fn((str) => {
    try { return JSON.parse(str); }
    catch { return null; }
  }),
  getPluginRoot: vi.fn(() => '/fake/plugin/root'),
  resolveConfigPath: vi.fn((...segs) => `/fake/plugin/root/${segs.join('/')}`),
  toFileUrl: vi.fn((p) => `file://${p}`),
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual('node:fs');
  return {
    ...actual,
    readFileSync: vi.fn((...args) => mockState.readFileSyncImpl(...args)),
    existsSync: vi.fn(() => mockState.existsSyncResult),
    writeFileSync: vi.fn(() => {}),
    mkdirSync: vi.fn(() => {}),
  };
});

vi.mock('node:os', async () => {
  const actual = await vi.importActual('node:os');
  return {
    ...actual,
    platform: vi.fn(() => 'win32'),
    arch: vi.fn(() => 'x64'),
  };
});

vi.mock('../../lib/core/version-checker.js', () => ({
  checkForUpdate: vi.fn(() => mockState.checkForUpdateFactory()),
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const POLL_MS = 25;
const SETTLE_TIMEOUT_MS = 3000;

describe('session-start hook', () => {
  let stderrSpy;
  let exitSpy;

  beforeEach(() => {
    vi.resetModules();
    mockState.readStdinResult = Promise.resolve('{}');
    mockState.writeStdoutCalls = [];
    mockState.readFileSyncImpl = () => { throw new Error('ENOENT'); };
    mockState.existsSyncResult = false;
    mockState.checkForUpdateFactory = () => Promise.resolve({ hasUpdate: false });
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {});
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
    delete process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS;
  });

  async function waitForStdout(timeoutMs = SETTLE_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (mockState.writeStdoutCalls.length > 0) {
        return;
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  }

  async function importAndWait(options = {}) {
    await import('../../scripts/hooks/session-start.js');
    if (options.waitForStdout === false) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      return;
    }
    await waitForStdout(options.timeoutMs);
  }

  describe('successful initialization', () => {
    it('calls writeStdout with a welcome message', async () => {
      mockState.readStdinResult = Promise.resolve(JSON.stringify({}));

      await importAndWait();

      expect(mockState.writeStdoutCalls.length).toBeGreaterThan(0);
      const output = mockState.writeStdoutCalls[0][0];
      expect(output).toHaveProperty('message');
      expect(output.message).toContain('Artibot');
    });

    it('does not call process.exit on success', async () => {
      mockState.readStdinResult = Promise.resolve(JSON.stringify({}));

      await importAndWait();

      expect(exitSpy).not.toHaveBeenCalled();
    });

    it('does not write to stderr on success when agent teams is active', async () => {
      process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1';
      mockState.readStdinResult = Promise.resolve(JSON.stringify({}));

      await importAndWait();

      // Filter out informational skill-hash cache messages (Phase 1 Quick Win).
      // These are advisory only, not errors, and may appear in test environments
      // where the cache module's dynamic import target is mocked.
      const stderrOutput = stderrSpy.mock.calls
        .map((c) => c[0])
        .filter((line) => !String(line).includes('skill-hash'))
        .join('');
      expect(stderrOutput).toBe('');
    });
  });

  describe('environment variables', () => {
    it('reports agent-teams (full) mode when CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1', async () => {
      process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1';
      mockState.readStdinResult = Promise.resolve(JSON.stringify({}));

      await importAndWait();

      const output = mockState.writeStdoutCalls[0][0];
      expect(output.message).toContain('agent-teams (full)');
    });

    it('shows advisory message when agent teams is not configured', async () => {
      mockState.readStdinResult = Promise.resolve(JSON.stringify({}));

      await importAndWait();

      const output = mockState.writeStdoutCalls[0][0];
      expect(output.message).toContain('sub-agent (fallback)');
      // Should write advisory to stderr instead of modifying settings.json
      const stderrOutput = stderrSpy.mock.calls.map((c) => c[0]).join('');
      expect(stderrOutput).toContain('Agent Teams not enabled');
    });

    it('does not modify settings.json (advisory only)', async () => {
      const { writeFileSync } = await import('node:fs');
      mockState.readStdinResult = Promise.resolve(JSON.stringify({}));

      await importAndWait();

      // Verify writeFileSync was never called with a settings.json path
      const settingsWrites = vi.mocked(writeFileSync).mock.calls
        .filter((c) => String(c[0]).includes('settings.json'));
      expect(settingsWrites).toHaveLength(0);
    });
  });

  describe('stdin handling', () => {
    it('handles empty stdin gracefully and still writes output', async () => {
      mockState.readStdinResult = Promise.resolve('');

      await importAndWait();

      // parseJSON returns null for empty string; the script falls back to defaults
      expect(mockState.writeStdoutCalls.length).toBeGreaterThan(0);
    });
  });

  describe('config loading', () => {
    it('reads artibot.config.json and uses the version from it', async () => {
      mockState.readFileSyncImpl = (filePath) => {
        if (String(filePath).includes('artibot.config.json')) {
          return JSON.stringify({ version: '2.0.0' });
        }
        throw new Error('ENOENT');
      };
      mockState.readStdinResult = Promise.resolve(JSON.stringify({}));

      await importAndWait();

      const output = mockState.writeStdoutCalls[0][0];
      expect(output.message).toContain('v2.0.0');
    });

    it('falls back to version 1.0.0 when config is missing', async () => {
      mockState.readStdinResult = Promise.resolve(JSON.stringify({}));

      await importAndWait();

      const output = mockState.writeStdoutCalls[0][0];
      expect(output.message).toContain('v1.0.0');
    });
  });

  describe('update notification', () => {
    it('appends update notice to message when a newer version is available', async () => {
      mockState.checkForUpdateFactory = () =>
        Promise.resolve({ hasUpdate: true, latestVersion: '9.9.9' });
      mockState.readStdinResult = Promise.resolve(JSON.stringify({}));

      await importAndWait();

      const output = mockState.writeStdoutCalls[0][0];
      expect(output.message).toContain('9.9.9');
      expect(output.message).toContain('/artibot:update --force');
    });

    it('does not append update notice when already on the latest version', async () => {
      mockState.checkForUpdateFactory = () =>
        Promise.resolve({ hasUpdate: false });
      mockState.readStdinResult = Promise.resolve(JSON.stringify({}));

      await importAndWait();

      const output = mockState.writeStdoutCalls[0][0];
      expect(output.message).not.toContain('/artibot:update');
    });

    it('still writes output when checkForUpdate rejects', async () => {
      // Factory returns a fresh rejected Promise on each call.
      // session-start.js catches it in its try/catch and continues to writeStdout.
      mockState.checkForUpdateFactory = () =>
        Promise.reject(new Error('network error'));
      mockState.readStdinResult = Promise.resolve(JSON.stringify({}));

      await importAndWait();

      // The try/catch in session-start.js swallows the error
      expect(mockState.writeStdoutCalls.length).toBeGreaterThan(0);
    });

    it('still writes output when checkForUpdate times out', async () => {
      // Factory returns a Promise that never resolves, so the 2000ms
      // Promise.race timeout in session-start.js fires. The catch block
      // swallows it and writeStdout is called.
      mockState.checkForUpdateFactory = () => new Promise(() => {});
      mockState.readStdinResult = Promise.resolve(JSON.stringify({}));

      await importAndWait({ timeoutMs: 2600 });

      expect(mockState.writeStdoutCalls.length).toBeGreaterThan(0);
    }, 5000);
  });
});
