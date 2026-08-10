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

/**
 * Import the hook and run its entry point. The module carries a direct-run
 * guard, so importing it no longer executes `main()` — the call has to be
 * explicit here, exactly as the spawned production process makes it.
 *
 * @returns {Promise<void>}
 */
async function runHook() {
  const mod = await import('../../scripts/hooks/git-autopilot-save.js');
  await mod.main();
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

    await runHook();
    await new Promise((r) => setTimeout(r, 30));

    // No commit attempt, no state write.
    expect(mockState.atomicWrites).toHaveLength(0);
  });

  it('refreshes state and exits when workspace is clean', async () => {
    const commands = setupRepo({ dirty: false });

    await runHook();
    await new Promise((r) => setTimeout(r, 30));

    // State timestamp refreshed exactly once
    expect(mockState.atomicWrites).toHaveLength(1);
    // No commit was attempted
    expect(commands.some((c) => c.cmd.startsWith('git commit'))).toBe(false);
    expect(commands.some((c) => c.cmd.startsWith('git add'))).toBe(false);
  });

  it('default config does NOT pass --no-verify to git commit (interval strategy)', async () => {
    // No bypassPreCommitHooks anywhere → Git Safety Protocol default
    const commands = setupRepo({
      config: {
        enabled: true,
        wipIntervalMinutes: 30,
        commitStrategy: 'interval',
      },
    });

    await runHook();
    await new Promise((r) => setTimeout(r, 30));

    const commitCmd = commands.find((c) => c.cmd.startsWith('git commit'));
    expect(commitCmd).toBeDefined();
    expect(commitCmd.cmd).not.toContain('--no-verify');
  });

  it('bypassPreCommitHooks=true (per-repo) appends --no-verify (interval strategy)', async () => {
    const commands = setupRepo({
      config: {
        enabled: true,
        wipIntervalMinutes: 30,
        commitStrategy: 'interval',
        bypassPreCommitHooks: true,
      },
    });

    await runHook();
    await new Promise((r) => setTimeout(r, 30));

    const commitCmd = commands.find((c) => c.cmd.startsWith('git commit'));
    expect(commitCmd).toBeDefined();
    expect(commitCmd.cmd).toContain('--no-verify');
  });

  it('per-repo bypassPreCommitHooks=true wins over artibot.config.json=false (interval strategy)', async () => {
    const commands = setupRepo({
      config: {
        enabled: true,
        wipIntervalMinutes: 30,
        commitStrategy: 'interval',
        bypassPreCommitHooks: true, // per-repo override
      },
      artibotConfig: { git: { autopilot: { bypassPreCommitHooks: false } } },
    });

    await runHook();
    await new Promise((r) => setTimeout(r, 30));

    const commitCmd = commands.find((c) => c.cmd.startsWith('git commit'));
    expect(commitCmd.cmd).toContain('--no-verify');
  });

  it('skips all git writes when isAutopilotAllowed returns false', async () => {
    const commands = setupRepo();
    mockState.allowed = false;

    await runHook();
    await new Promise((r) => setTimeout(r, 30));

    expect(commands.some((c) => c.cmd.startsWith('git add'))).toBe(false);
    expect(commands.some((c) => c.cmd.startsWith('git commit'))).toBe(false);
    expect(mockState.atomicWrites).toHaveLength(0);
  });

  it('passes a 2000ms timeout option to git status invocation', async () => {
    const commands = setupRepo();

    await runHook();
    await new Promise((r) => setTimeout(r, 30));

    const statusCall = commands.find((c) => c.cmd === 'git status --porcelain');
    expect(statusCall).toBeDefined();
    expect(statusCall.opts?.timeout).toBe(2000);
  });

  it('skips WIP commit when only auto-generated files are dirty (auto-learned-rules.json)', async () => {
    // Regression for cross-machine version drift: WIP firing on pure
    // auto-generated changes leaves the local branch "ahead of origin"
    // even though there's no real user work to preserve.
    const commands = setupRepo();
    mockState.execSyncImpl = (cmd, _opts) => {
      commands.push({ cmd, opts: _opts });
      if (cmd === 'git rev-parse --show-toplevel') return '/repo\n';
      if (cmd === 'git status --porcelain') {
        return ' M plugins/artibot/skills/coding-standards/references/auto-learned-rules.json\n';
      }
      return '';
    };

    await runHook();
    await new Promise((r) => setTimeout(r, 30));

    expect(commands.some((c) => c.cmd.startsWith('git add'))).toBe(false);
    expect(commands.some((c) => c.cmd.startsWith('git commit'))).toBe(false);
    // Timestamp still refreshed so we don't re-check immediately.
    expect(mockState.atomicWrites).toHaveLength(1);
  });

  it('fires WIP commit when auto-generated AND real files are both dirty (interval strategy)', async () => {
    const commands = setupRepo({
      config: {
        enabled: true,
        wipIntervalMinutes: 30,
        commitStrategy: 'interval',
      },
    });
    mockState.execSyncImpl = (cmd, _opts) => {
      commands.push({ cmd, opts: _opts });
      if (cmd === 'git rev-parse --show-toplevel') return '/repo\n';
      if (cmd === 'git status --porcelain') {
        return ' M plugins/artibot/skills/coding-standards/references/auto-learned-rules.json\n M src/feature.ts\n';
      }
      return '';
    };

    await runHook();
    await new Promise((r) => setTimeout(r, 30));

    expect(commands.some((c) => c.cmd.startsWith('git add'))).toBe(true);
    expect(commands.some((c) => c.cmd.startsWith('git commit'))).toBe(true);
  });

  it('skips WIP when only runtime/ files are dirty', async () => {
    const commands = setupRepo();
    mockState.execSyncImpl = (cmd, _opts) => {
      commands.push({ cmd, opts: _opts });
      if (cmd === 'git rev-parse --show-toplevel') return '/repo\n';
      if (cmd === 'git status --porcelain') {
        return ' M plugins/artibot/runtime/state/session.json\n';
      }
      return '';
    };

    await runHook();
    await new Promise((r) => setTimeout(r, 30));

    expect(commands.some((c) => c.cmd.startsWith('git commit'))).toBe(false);
  });

  it('uses --no-verify only as a deliberate opt-in (metadata assert, interval strategy)', async () => {
    // Twin run: default = no flag; bypass = flag present.
    // This guards against any future refactor that flips the default.
    const cmds1 = setupRepo({
      config: { enabled: true, wipIntervalMinutes: 30, commitStrategy: 'interval' },
    });
    await runHook();
    await new Promise((r) => setTimeout(r, 30));
    const commit1 = cmds1.find((c) => c.cmd.startsWith('git commit'));
    expect(commit1.cmd).not.toContain('--no-verify');

    vi.resetModules();
    resetState();
    const cmds2 = setupRepo({
      config: { enabled: true, wipIntervalMinutes: 30, commitStrategy: 'interval', bypassPreCommitHooks: true },
    });
    await runHook();
    await new Promise((r) => setTimeout(r, 30));
    const commit2 = cmds2.find((c) => c.cmd.startsWith('git commit'));
    expect(commit2.cmd).toContain('--no-verify');
  });

  // -------------------------------------------------------------------------
  // Stash checkpoint tests (commitStrategy: "semantic")
  // -------------------------------------------------------------------------

  it('default (semantic) strategy runs non-destructive stash create + store (never push/pop)', async () => {
    const commands = setupRepo();
    mockState.execSyncImpl = (cmd, _opts) => {
      commands.push({ cmd, opts: _opts });
      if (cmd === 'git rev-parse --show-toplevel') return '/repo\n';
      if (cmd === 'git status --porcelain') return ' M file.js\n';
      if (cmd === 'git stash create') return 'deadbeefcafe\n';
      if (cmd.startsWith('git stash store')) return '';
      return '';
    };

    await runHook();
    await new Promise((r) => setTimeout(r, 30));

    // Non-destructive snapshot: create + store, NEVER push/pop (which would
    // hard-reset the working tree and could lose a concurrent teammate's edits).
    expect(commands.some((c) => c.cmd === 'git stash create')).toBe(true);
    expect(commands.some((c) => c.cmd.startsWith('git stash store'))).toBe(true);
    expect(commands.some((c) => c.cmd.startsWith('git stash push'))).toBe(false);
    expect(commands.some((c) => c.cmd === 'git stash pop')).toBe(false);
    // No git commit / add -A either.
    expect(commands.some((c) => c.cmd.startsWith('git commit'))).toBe(false);
    expect(commands.some((c) => c.cmd.startsWith('git add -A'))).toBe(false);
    // State should be saved.
    expect(mockState.atomicWrites).toHaveLength(1);
  });

  it('semantic strategy never touches the working tree (no push/pop/reset)', async () => {
    const commands = setupRepo();
    mockState.execSyncImpl = (cmd, _opts) => {
      commands.push({ cmd, opts: _opts });
      if (cmd === 'git rev-parse --show-toplevel') return '/repo\n';
      if (cmd === 'git status --porcelain') return ' M file.js\n';
      if (cmd === 'git stash create') return 'deadbeefcafe\n';
      if (cmd.startsWith('git stash store')) return '';
      return '';
    };

    await runHook();
    await new Promise((r) => setTimeout(r, 30));

    // None of the tree-mutating git commands should ever appear.
    expect(commands.some((c) => c.cmd.startsWith('git stash push'))).toBe(false);
    expect(commands.some((c) => c.cmd === 'git stash pop')).toBe(false);
    expect(commands.some((c) => c.cmd.startsWith('git reset'))).toBe(false);
    expect(commands.some((c) => c.cmd.startsWith('git checkout'))).toBe(false);
  });

  it('semantic strategy uses currentPhase from config in stash store label', async () => {
    const commands = setupRepo({
      config: {
        enabled: true,
        wipIntervalMinutes: 30,
        currentPhase: 'EXECUTE',
      },
    });
    mockState.execSyncImpl = (cmd, _opts) => {
      commands.push({ cmd, opts: _opts });
      if (cmd === 'git rev-parse --show-toplevel') return '/repo\n';
      if (cmd === 'git status --porcelain') return ' M file.js\n';
      if (cmd === 'git stash create') return 'deadbeefcafe\n';
      if (cmd.startsWith('git stash store')) return '';
      return '';
    };

    await runHook();
    await new Promise((r) => setTimeout(r, 30));

    const stashStore = commands.find((c) => c.cmd.startsWith('git stash store'));
    expect(stashStore).toBeDefined();
    expect(stashStore.cmd).toContain('artibot-checkpoint-EXECUTE-');
  });

  it('semantic strategy: store failure is non-fatal and never disturbs the tree', async () => {
    const commands = setupRepo();
    mockState.execSyncImpl = (cmd, _opts) => {
      commands.push({ cmd, opts: _opts });
      if (cmd === 'git rev-parse --show-toplevel') return '/repo\n';
      if (cmd === 'git status --porcelain') return ' M file.js\n';
      if (cmd === 'git stash create') return 'deadbeefcafe\n';
      if (cmd.startsWith('git stash store')) throw new Error('store failed');
      return '';
    };

    await runHook();
    await new Promise((r) => setTimeout(r, 30));

    // State still saved (timestamp update is independent of checkpoint success).
    expect(mockState.atomicWrites).toHaveLength(1);
    // No tree-mutating recovery attempted — the snapshot object is harmless.
    expect(commands.some((c) => c.cmd === 'git stash pop')).toBe(false);
    expect(commands.some((c) => c.cmd.startsWith('git reset'))).toBe(false);
    // "skipped" message emitted (checkpoint returned false).
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('stash checkpoint skipped'),
    );
  });

  it('semantic strategy returns false when nothing was stashed (no changes)', async () => {
    const commands = setupRepo();
    mockState.execSyncImpl = (cmd, _opts) => {
      commands.push({ cmd, opts: _opts });
      if (cmd === 'git rev-parse --show-toplevel') return '/repo\n';
      if (cmd === 'git status --porcelain') return ' M file.js\n';
      // create returns empty — no tracked changes to snapshot.
      if (cmd === 'git stash create') return '';
      return '';
    };

    await runHook();
    await new Promise((r) => setTimeout(r, 30));

    // create returned empty → no store attempted, no tree mutation.
    expect(commands.some((c) => c.cmd.startsWith('git stash store'))).toBe(false);
    expect(commands.some((c) => c.cmd === 'git stash pop')).toBe(false);
    // State still saved (timestamp updated).
    expect(mockState.atomicWrites).toHaveLength(1);
  });

  it('commitStrategy "none" skips all auto-save activity', async () => {
    const commands = setupRepo({
      config: {
        enabled: true,
        wipIntervalMinutes: 30,
        commitStrategy: 'none',
      },
    });

    await runHook();
    await new Promise((r) => setTimeout(r, 30));

    // No stash, no commit, no state write.
    expect(commands.some((c) => c.cmd.startsWith('git stash'))).toBe(false);
    expect(commands.some((c) => c.cmd.startsWith('git commit'))).toBe(false);
    expect(commands.some((c) => c.cmd.startsWith('git add'))).toBe(false);
    expect(mockState.atomicWrites).toHaveLength(0);
  });

  it('semantic strategy triggers cleanup of old stashes', async () => {
    const commands = setupRepo();
    mockState.execSyncImpl = (cmd, _opts) => {
      commands.push({ cmd, opts: _opts });
      if (cmd === 'git rev-parse --show-toplevel') return '/repo\n';
      if (cmd === 'git status --porcelain') return ' M file.js\n';
      if (cmd === 'git stash create') return 'deadbeefcafe\n';
      if (cmd.startsWith('git stash store')) return '';
      if (cmd === 'git stash list') {
        // Simulate 12 artibot checkpoints (max default is 10, so 2 should be dropped).
        const lines = [];
        for (let i = 0; i < 12; i++) {
          lines.push(`stash@{${i}}: On main: artibot-checkpoint-autopilot-2026-05-${String(26 - i).padStart(2, '0')} 10:00:00`);
        }
        return lines.join('\n') + '\n';
      }
      if (cmd === 'git stash pop') return '';
      if (cmd.startsWith('git stash drop')) return '';
      return '';
    };

    await runHook();
    await new Promise((r) => setTimeout(r, 30));

    // Two stash drop commands should have been issued (indices 11 and 10, in descending order).
    const drops = commands.filter((c) => c.cmd.startsWith('git stash drop'));
    expect(drops).toHaveLength(2);
    expect(drops[0].cmd).toContain('stash@{11}');
    expect(drops[1].cmd).toContain('stash@{10}');
  });

  it('direct-run guard: importing the module runs no git command', async () => {
    // setupRepo() leaves a state where an auto-save WOULD fire (interval long
    // elapsed, workspace dirty). Importing must still write nothing: without
    // the guard, `main()` blocks on stdin and then mutates the real repo. Only
    // the mocks stood between an import and a live `git add -A` before this.
    const commands = setupRepo({ dirty: true });

    await import('../../scripts/hooks/git-autopilot-save.js');
    await new Promise((r) => setTimeout(r, 30));

    expect(commands).toHaveLength(0);
    expect(mockState.atomicWrites).toHaveLength(0);
  });
});
