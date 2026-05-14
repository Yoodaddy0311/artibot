import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Regression tests for scripts/hooks/git-autopilot-save.js.
 *
 * Focus areas (issue-scanner A2 #9):
 *   - Interval gate (no-op when wipIntervalMinutes hasn't elapsed)
 *   - Clean workspace path (state timestamp refreshed, no commit)
 *   - bypassPreCommitHooks default = false → commit args MUST NOT include --no-verify
 *     (v4.7.2 Git Safety Protocol fix — see hook docstring)
 *   - bypassPreCommitHooks = true → --no-verify appended
 *   - Per-repo .git/autopilot.json bypassPreCommitHooks precedence over
 *     artibot.config.json
 *   - Allowlist gate (isAutopilotAllowed=false → zero git writes)
 *   - execSync timeout option preserved on git invocations
 */

// ---------------------------------------------------------------------------
// Shared mock state
// ---------------------------------------------------------------------------
const mockState = {
  readStdinResult: Promise.resolve('{}'),
  existsSyncResults: {},
  readFileSyncImpl: () => { throw new Error('ENOENT'); },
  execSyncImpl: () => '',
  atomicWrites: [],
  allowed: true,
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
  atomicWriteSync: vi.fn((p, data) => { mockState.atomicWrites.push({ path: p, data }); }),
  resolveConfigPath: vi.fn((name) => `/cfg/${name}`),
}));

vi.mock('../../lib/core/hook-utils.js', () => ({
  createErrorHandler: vi.fn(() => () => {}),
}));

vi.mock('../../lib/autopilot/repo-identity.js', () => ({
  isAutopilotAllowed: vi.fn(() => mockState.allowed),
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual('node:fs');
  return {
    ...actual,
    existsSync: vi.fn((p) => {
      for (const [key, val] of Object.entries(mockState.existsSyncResults)) {
        if (String(p).includes(key)) return val;
      }
      return false;
    }),
    readFileSync: vi.fn((...args) => mockState.readFileSyncImpl(...args)),
  };
});

vi.mock('node:child_process', () => ({
  execSync: vi.fn((...args) => mockState.execSyncImpl(...args)),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function resetState() {
  mockState.readStdinResult = Promise.resolve('{}');
  mockState.existsSyncResults = {};
  mockState.readFileSyncImpl = () => { throw new Error('ENOENT'); };
  mockState.execSyncImpl = () => '';
  mockState.atomicWrites = [];
  mockState.allowed = true;
}

/**
 * Configure mocks for an enabled autopilot repo whose wip interval is
 * already elapsed. Returns the list of commands captured by execSync so
 * tests can assert on shell-level arguments.
 *
 * @param {object} opts
 * @param {boolean} [opts.dirty=true] workspace has uncommitted changes
 * @param {object} [opts.config] config returned for .git/autopilot.json
 * @param {object} [opts.artibotConfig] config returned for artibot.config.json
 *   (only the git.autopilot.bypassPreCommitHooks key is read).
 */
function setupRepo(opts = {}) {
  const dirty = opts.dirty !== false;
  const config = opts.config ?? {
    enabled: true,
    wipIntervalMinutes: 30,
  };

  const commands = [];
  mockState.execSyncImpl = (cmd, _opts) => {
    commands.push({ cmd, opts: _opts });
    if (cmd === 'git rev-parse --show-toplevel') return '/repo\n';
    if (cmd === 'git status --porcelain') return dirty ? ' M file.js\n' : '';
    if (cmd.startsWith('git add')) return '';
    if (cmd.startsWith('git commit')) return '';
    return '';
  };

  mockState.existsSyncResults = {
    'autopilot.json': true,
    'autopilot-state.json': true,
  };

  mockState.readFileSyncImpl = (p) => {
    const sp = String(p);
    if (sp.includes('autopilot-state.json')) {
      // Last WIP one year ago — interval definitely elapsed.
      return JSON.stringify({ lastWipAt: '2024-01-01T00:00:00.000Z' });
    }
    if (sp.includes('.git/autopilot.json') || sp.endsWith('autopilot.json')) {
      return JSON.stringify(config);
    }
    if (sp.includes('artibot.config.json')) {
      return JSON.stringify(opts.artibotConfig ?? {});
    }
    throw new Error('ENOENT');
  };

  return commands;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('git-autopilot-save', () => {
  let stderrSpy;

  beforeEach(() => {
    vi.resetModules();
    resetState();
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it('is a no-op when the WIP interval has not elapsed', async () => {
    setupRepo();
    mockState.readFileSyncImpl = (p) => {
      const sp = String(p);
      if (sp.includes('autopilot-state.json')) {
        // Just saved — interval cannot have elapsed.
        return JSON.stringify({ lastWipAt: new Date().toISOString() });
      }
      if (sp.includes('autopilot.json')) {
        return JSON.stringify({ enabled: true, wipIntervalMinutes: 30 });
      }
      return '{}';
    };

    await import('../../scripts/hooks/git-autopilot-save.js');
    await new Promise((r) => setTimeout(r, 30));

    // No commit attempt, no state write.
    expect(mockState.atomicWrites).toHaveLength(0);
  });

  it('refreshes state and exits when workspace is clean', async () => {
    const commands = setupRepo({ dirty: false });

    await import('../../scripts/hooks/git-autopilot-save.js');
    await new Promise((r) => setTimeout(r, 30));

    // State timestamp refreshed exactly once
    expect(mockState.atomicWrites).toHaveLength(1);
    // No commit was attempted
    expect(commands.some((c) => c.cmd.startsWith('git commit'))).toBe(false);
    expect(commands.some((c) => c.cmd.startsWith('git add'))).toBe(false);
  });

  it('default config does NOT pass --no-verify to git commit', async () => {
    // No bypassPreCommitHooks anywhere → Git Safety Protocol default
    const commands = setupRepo();

    await import('../../scripts/hooks/git-autopilot-save.js');
    await new Promise((r) => setTimeout(r, 30));

    const commitCmd = commands.find((c) => c.cmd.startsWith('git commit'));
    expect(commitCmd).toBeDefined();
    expect(commitCmd.cmd).not.toContain('--no-verify');
  });

  it('bypassPreCommitHooks=true (per-repo) appends --no-verify', async () => {
    const commands = setupRepo({
      config: {
        enabled: true,
        wipIntervalMinutes: 30,
        bypassPreCommitHooks: true,
      },
    });

    await import('../../scripts/hooks/git-autopilot-save.js');
    await new Promise((r) => setTimeout(r, 30));

    const commitCmd = commands.find((c) => c.cmd.startsWith('git commit'));
    expect(commitCmd).toBeDefined();
    expect(commitCmd.cmd).toContain('--no-verify');
  });

  it('per-repo bypassPreCommitHooks=true wins over artibot.config.json=false', async () => {
    const commands = setupRepo({
      config: {
        enabled: true,
        wipIntervalMinutes: 30,
        bypassPreCommitHooks: true, // per-repo override
      },
      artibotConfig: { git: { autopilot: { bypassPreCommitHooks: false } } },
    });

    await import('../../scripts/hooks/git-autopilot-save.js');
    await new Promise((r) => setTimeout(r, 30));

    const commitCmd = commands.find((c) => c.cmd.startsWith('git commit'));
    expect(commitCmd.cmd).toContain('--no-verify');
  });

  it('skips all git writes when isAutopilotAllowed returns false', async () => {
    const commands = setupRepo();
    mockState.allowed = false;

    await import('../../scripts/hooks/git-autopilot-save.js');
    await new Promise((r) => setTimeout(r, 30));

    expect(commands.some((c) => c.cmd.startsWith('git add'))).toBe(false);
    expect(commands.some((c) => c.cmd.startsWith('git commit'))).toBe(false);
    expect(mockState.atomicWrites).toHaveLength(0);
  });

  it('passes a 2000ms timeout option to git status invocation', async () => {
    const commands = setupRepo();

    await import('../../scripts/hooks/git-autopilot-save.js');
    await new Promise((r) => setTimeout(r, 30));

    const statusCall = commands.find((c) => c.cmd === 'git status --porcelain');
    expect(statusCall).toBeDefined();
    expect(statusCall.opts?.timeout).toBe(2000);
  });

  it('uses --no-verify only as a deliberate opt-in (metadata assert)', async () => {
    // Twin run: default = no flag; bypass = flag present.
    // This guards against any future refactor that flips the default.
    const cmds1 = setupRepo();
    await import('../../scripts/hooks/git-autopilot-save.js');
    await new Promise((r) => setTimeout(r, 30));
    const commit1 = cmds1.find((c) => c.cmd.startsWith('git commit'));
    expect(commit1.cmd).not.toContain('--no-verify');

    vi.resetModules();
    resetState();
    const cmds2 = setupRepo({
      config: { enabled: true, wipIntervalMinutes: 30, bypassPreCommitHooks: true },
    });
    await import('../../scripts/hooks/git-autopilot-save.js');
    await new Promise((r) => setTimeout(r, 30));
    const commit2 = cmds2.find((c) => c.cmd.startsWith('git commit'));
    expect(commit2.cmd).toContain('--no-verify');
  });
});
