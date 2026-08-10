import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * git-autopilot-close.js — Stop hook that commits, squashes WIP, and pushes.
 *
 * Source uses execFileSync (argv-array, shell-free) and resolveBaseBranch
 * from lib/git/resolve-base.js.  Tests mock both to drive code paths.
 *
 * Squad A signature change (Phase 2c):
 *   countWipCommits(cwd, baseBranch)
 *   squashWipCommits(cwd, baseBranch, wipCount)
 * (previously took branchPrefix params).
 */

// ---------------------------------------------------------------------------
// Shared mock state
// ---------------------------------------------------------------------------
const mockState = {
  readStdinResult: Promise.resolve('{}'),
  existsSyncResults: {},
  readFileSyncImpl: () => { throw new Error('ENOENT'); },
  /** Maps a "command signature" (first arg array stringified) to a return value or thrower. */
  execFileSyncImpl: () => '',
  resolveBaseImpl: () => 'master',
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
  resolveConfigPath: vi.fn((...segments) => ['__plugin_root__', ...segments].join('/')),
}));

vi.mock('../../lib/core/hook-utils.js', () => ({
  createErrorHandler: vi.fn(() => () => {}),
  logHookError: vi.fn(),
}));

vi.mock('../../lib/git/resolve-base.js', () => ({
  resolveBaseBranch: vi.fn((...args) => mockState.resolveBaseImpl(...args)),
  // v4.5.12 — squashWipCommits now calls isMergeBaseFresh; default to true
  // (happy-path) and let individual tests override mockState.isMergeBaseFreshImpl
  // when they want to exercise the age-gate refusal path.
  isMergeBaseFresh: vi.fn((...args) =>
    mockState.isMergeBaseFreshImpl ? mockState.isMergeBaseFreshImpl(...args) : true,
  ),
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
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn((file, args, opts) => mockState.execFileSyncImpl(file, args, opts)),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function resetState() {
  mockState.readStdinResult = Promise.resolve('{}');
  mockState.existsSyncResults = {};
  mockState.readFileSyncImpl = () => { throw new Error('ENOENT'); };
  mockState.execFileSyncImpl = () => '';
  mockState.resolveBaseImpl = () => 'master';
  mockState.isMergeBaseFreshImpl = null; // null → default true (happy path)
}

function setupEnabledRepo(overrides = {}) {
  const config = {
    enabled: true,
    autoPullOnSession: true,
    autoPushOnStop: true,
    squashWipOnClose: true,
    branchPrefix: 'artibot/',
    // v4.11.3: existing test cases assume the full close pipeline runs.
    // The new closeOnStop gate defaults to false in production; we opt in
    // here so the legacy expectations (commit / squash / push) stay valid.
    // Individual tests can override by passing `closeOnStop: false` (or
    // omitting via a fresh config object) to exercise the new gate.
    closeOnStop: true,
    ...overrides,
  };

  mockState.existsSyncResults = { 'autopilot.json': true };
  mockState.readFileSyncImpl = (p) => {
    const ps = String(p);
    if (ps.includes('autopilot.json') && !ps.includes('artibot.config')) return JSON.stringify(config);
    if (ps.includes('artibot.config.json')) {
      return JSON.stringify({ git: { autopilot: { commitStrategy: 'interval' } } });
    }
    throw new Error('ENOENT');
  };

  return config;
}

/**
 * Build a flexible execFileSync mock from a list of [argMatcher, response] pairs.
 * argMatcher is a substring matched against `args.join(' ')`.
 * response can be a string or () => string.  Throws Error('mock-throw') by setting null.
 *
 * Auto-injects an artibot allowlist response for `git config --get remote.origin.url`
 * so capture-only gate (v4.4.0+) lets the hook proceed.
 */
function makeExec(rules, fallback = '') {
  return (file, args /*, opts */) => {
    if (file !== 'git') return fallback;
    const joined = (args || []).join(' ');
    if (joined === 'config --get remote.origin.url') {
      return 'https://github.com/Yoodaddy0311/artibot.git';
    }
    for (const [matcher, response] of rules) {
      if (joined.includes(matcher) || joined === matcher) {
        if (response instanceof Error) throw response;
        return typeof response === 'function' ? response() : response;
      }
    }
    return fallback;
  };
}

/**
 * Import the hook and run its entry point. The module carries a direct-run
 * guard, so importing it no longer executes `main()` — the call has to be
 * explicit here, exactly as the spawned production process makes it.
 *
 * @returns {Promise<void>}
 */
async function runHook() {
  const mod = await import('../../scripts/hooks/git-autopilot-close.js');
  await mod.main();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('git-autopilot-close', () => {
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

  it('should skip silently when not in a git repo', async () => {
    mockState.execFileSyncImpl = (file, args) => {
      if (file === 'git' && args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
        throw new Error('not a repo');
      }
      return '';
    };

    await runHook();
    const logs = stderrSpy.mock.calls.map(([m]) => m).join('');
    expect(logs).not.toContain('commit');
  });

  it('should skip when config is missing', async () => {
    mockState.execFileSyncImpl = makeExec([
      ['rev-parse --show-toplevel', '/repo'],
    ]);
    mockState.existsSyncResults = { 'autopilot.json': false };

    await runHook();
    const logs = stderrSpy.mock.calls.map(([m]) => m).join('');
    expect(logs).not.toContain('commit');
  });

  it('should commit when workspace is dirty', async () => {
    setupEnabledRepo({ autoPushOnStop: false, squashWipOnClose: false });
    const recorded = [];
    mockState.execFileSyncImpl = (file, args) => {
      recorded.push(args);
      const joined = (args || []).join(' ');
      if (joined === 'rev-parse --show-toplevel') return '/repo';
      if (joined === 'config --get remote.origin.url') {
        return 'https://github.com/Yoodaddy0311/artibot.git';
      }
      if (joined === 'branch --show-current') return 'main';
      if (joined.startsWith('status --porcelain')) return 'M file.js\n';
      return '';
    };

    await runHook();
    const logs = stderrSpy.mock.calls.map(([m]) => m).join('');
    expect(logs).toContain('Final changes committed');
    expect(recorded.some((a) => a.join(' ') === 'add -A')).toBe(true);
  });

  it('should log "No uncommitted changes" when workspace is clean', async () => {
    setupEnabledRepo({ autoPushOnStop: false, squashWipOnClose: false });
    mockState.execFileSyncImpl = makeExec([
      ['rev-parse --show-toplevel', '/repo'],
      ['branch --show-current', 'main'],
      ['status --porcelain', ''],
    ]);

    await runHook();
    const logs = stderrSpy.mock.calls.map(([m]) => m).join('');
    expect(logs).toContain('No uncommitted changes');
  });

  it('should squash WIP commits on autopilot branch', async () => {
    setupEnabledRepo({ autoPushOnStop: false });
    const recorded = [];
    mockState.resolveBaseImpl = () => 'master';
    mockState.execFileSyncImpl = (file, args) => {
      recorded.push(args);
      const joined = (args || []).join(' ');
      if (joined === 'rev-parse --show-toplevel') return '/repo';
      if (joined === 'config --get remote.origin.url') {
        return 'https://github.com/Yoodaddy0311/artibot.git';
      }
      if (joined === 'branch --show-current') return 'artibot/master';
      if (joined.startsWith('status --porcelain')) return '';
      if (joined.startsWith('merge-base')) return 'abc123';
      if (joined.includes('--grep=^wip:')) return 'aaa wip\nbbb wip\nccc wip\n';
      if (joined.startsWith('rev-list --count')) return '5';
      return '';
    };

    await runHook();
    const logs = stderrSpy.mock.calls.map(([m]) => m).join('');
    expect(logs).toContain('Squashed');
    expect(recorded.some((a) => a[0] === 'reset' && a[1] === '--soft')).toBe(true);
  });

  it('should skip squash when not on autopilot branch', async () => {
    setupEnabledRepo({ autoPushOnStop: false });
    mockState.execFileSyncImpl = makeExec([
      ['rev-parse --show-toplevel', '/repo'],
      ['branch --show-current', 'main'],
      ['status --porcelain', ''],
    ]);

    await runHook();
    const logs = stderrSpy.mock.calls.map(([m]) => m).join('');
    expect(logs).not.toContain('Squashed');
  });

  it('should push branch when autoPushOnStop is true', async () => {
    setupEnabledRepo();
    const recorded = [];
    mockState.execFileSyncImpl = (file, args) => {
      recorded.push(args);
      const joined = (args || []).join(' ');
      if (joined === 'rev-parse --show-toplevel') return '/repo';
      if (joined === 'config --get remote.origin.url') {
        return 'https://github.com/Yoodaddy0311/artibot.git';
      }
      if (joined === 'branch --show-current') return 'artibot/master';
      if (joined.startsWith('status --porcelain')) return '';
      if (joined.startsWith('merge-base')) return 'abc123';
      if (joined.includes('--grep=^wip:')) return '';
      return '';
    };

    await runHook();
    const logs = stderrSpy.mock.calls.map(([m]) => m).join('');
    expect(logs).toContain('Pushed');
    expect(recorded.some((a) => a[0] === 'push' && a.includes('origin'))).toBe(true);
  });

  it('should retry push with -u on first push failure', async () => {
    setupEnabledRepo();
    let pushAttempt = 0;
    mockState.execFileSyncImpl = (file, args) => {
      const joined = (args || []).join(' ');
      if (joined === 'rev-parse --show-toplevel') return '/repo';
      if (joined === 'config --get remote.origin.url') {
        return 'https://github.com/Yoodaddy0311/artibot.git';
      }
      if (joined === 'branch --show-current') return 'artibot/master';
      if (joined.startsWith('status --porcelain')) return '';
      if (joined.startsWith('merge-base')) return 'abc123';
      if (joined.includes('--grep=^wip:')) return '';
      if (args[0] === 'push' && args[1] === 'origin') {
        pushAttempt += 1;
        if (pushAttempt === 1) throw new Error('no upstream');
        return '';
      }
      if (args[0] === 'push' && args[1] === '-u') return '';
      return '';
    };

    await runHook();
    const logs = stderrSpy.mock.calls.map(([m]) => m).join('');
    expect(logs).toContain('Pushed');
  });

  it('should log push failure when both push attempts fail', async () => {
    setupEnabledRepo();
    mockState.execFileSyncImpl = (file, args) => {
      const joined = (args || []).join(' ');
      if (joined === 'rev-parse --show-toplevel') return '/repo';
      if (joined === 'config --get remote.origin.url') {
        return 'https://github.com/Yoodaddy0311/artibot.git';
      }
      if (joined === 'branch --show-current') return 'artibot/master';
      if (joined.startsWith('status --porcelain')) return '';
      if (joined.startsWith('merge-base')) return 'abc123';
      if (joined.includes('--grep=^wip:')) return '';
      if (args[0] === 'push') throw new Error('push failed');
      return '';
    };

    await runHook();
    const logs = stderrSpy.mock.calls.map(([m]) => m).join('');
    expect(logs).toContain('Push failed');
  });
});

// ---------------------------------------------------------------------------
// A-2 squash safety guards (Phase 2c P0 fix)
// ---------------------------------------------------------------------------
describe('git-autopilot-close — squashWipCommits safety guards', () => {
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

  it('skips squash and reports failure when totalCommits exceeds the 50-commit ceiling', async () => {
    setupEnabledRepo({ autoPushOnStop: false });
    const recorded = [];
    mockState.resolveBaseImpl = () => 'master';
    mockState.execFileSyncImpl = (file, args) => {
      recorded.push(args);
      const joined = (args || []).join(' ');
      if (joined === 'rev-parse --show-toplevel') return '/repo';
      if (joined === 'config --get remote.origin.url') {
        return 'https://github.com/Yoodaddy0311/artibot.git';
      }
      if (joined === 'branch --show-current') return 'artibot/master';
      if (joined.startsWith('status --porcelain')) return '';
      if (joined.startsWith('merge-base')) return 'abc123';
      // wip count high enough to trigger squash attempt
      if (joined.includes('--grep=^wip:')) return Array.from({ length: 5 }).map((_, i) => `c${i} wip`).join('\n');
      // ABNORMAL: 9999 commits since merge-base — likely ancient ancestor mis-resolution
      if (joined.startsWith('rev-list --count')) return '9999';
      return '';
    };

    await runHook();
    // squash MUST refuse to reset when totalCommits > MAX_SQUASH_COMMITS.
    expect(recorded.some((a) => a[0] === 'reset')).toBe(false);
    const logs = stderrSpy.mock.calls.map(([m]) => m).join('');
    expect(logs).toContain('WIP squash failed');
  });

  it('skips push when squashWipOnClose=true and squash fails (autoPushOnStop=true)', async () => {
    // v4.7.7 audit P1: previously, when squash failed (e.g. totalCommits
    // exceeded the safety ceiling), `pushBranch` still ran and published
    // the raw `wip: artibot auto-save [...]` commits the squash was meant
    // to hide. The gate must hold push back until squash succeeds.
    setupEnabledRepo(); // autoPushOnStop:true, squashWipOnClose:true
    const recorded = [];
    mockState.resolveBaseImpl = () => 'master';
    mockState.execFileSyncImpl = (file, args) => {
      recorded.push(args);
      const joined = (args || []).join(' ');
      if (joined === 'rev-parse --show-toplevel') return '/repo';
      if (joined === 'config --get remote.origin.url') {
        return 'https://github.com/Yoodaddy0311/artibot.git';
      }
      if (joined === 'branch --show-current') return 'artibot/master';
      if (joined.startsWith('status --porcelain')) return '';
      if (joined.startsWith('merge-base')) return 'abc123';
      if (joined.includes('--grep=^wip:')) return 'aaa wip\nbbb wip\nccc wip\n';
      // Force squash failure via 50-commit ceiling
      if (joined.startsWith('rev-list --count')) return '9999';
      return '';
    };

    await runHook();
    const logs = stderrSpy.mock.calls.map(([m]) => m).join('');
    expect(logs).toContain('WIP squash failed');
    expect(logs).toContain('Push skipped');
    // No push command should have been issued.
    expect(recorded.some((a) => a[0] === 'push')).toBe(false);
  });

  it('still pushes when squash succeeds (autoPushOnStop=true)', async () => {
    setupEnabledRepo();
    const recorded = [];
    mockState.resolveBaseImpl = () => 'master';
    mockState.execFileSyncImpl = (file, args) => {
      recorded.push(args);
      const joined = (args || []).join(' ');
      if (joined === 'rev-parse --show-toplevel') return '/repo';
      if (joined === 'config --get remote.origin.url') {
        return 'https://github.com/Yoodaddy0311/artibot.git';
      }
      if (joined === 'branch --show-current') return 'artibot/master';
      if (joined.startsWith('status --porcelain')) return '';
      if (joined.startsWith('merge-base')) return 'abc123';
      if (joined.includes('--grep=^wip:')) return 'aaa wip\nbbb wip\n';
      // Normal squash count (under ceiling)
      if (joined.startsWith('rev-list --count')) return '5';
      return '';
    };

    await runHook();
    const logs = stderrSpy.mock.calls.map(([m]) => m).join('');
    expect(logs).toContain('Squashed');
    expect(logs).not.toContain('Push skipped');
    expect(recorded.some((a) => a[0] === 'push')).toBe(true);
  });

  it('skips squash when merge-base resolves to an empty string', async () => {
    setupEnabledRepo({ autoPushOnStop: false });
    const recorded = [];
    mockState.resolveBaseImpl = () => 'master';
    mockState.execFileSyncImpl = (file, args) => {
      recorded.push(args);
      const joined = (args || []).join(' ');
      if (joined === 'rev-parse --show-toplevel') return '/repo';
      if (joined === 'config --get remote.origin.url') {
        return 'https://github.com/Yoodaddy0311/artibot.git';
      }
      if (joined === 'branch --show-current') return 'artibot/master';
      if (joined.startsWith('status --porcelain')) return '';
      // merge-base returns empty (resolution failed but didn't throw)
      if (joined.startsWith('merge-base')) return '';
      // wip count uses the SAME merge-base; with empty mergeBase countWipCommits returns 0,
      // so squash is never attempted.  Stub anyway in case.
      if (joined.includes('--grep=^wip:')) return 'aaa wip\nbbb wip\n';
      if (joined.startsWith('rev-list --count')) return '5';
      return '';
    };

    await runHook();
    // No reset issued because guard short-circuits.
    expect(recorded.some((a) => a[0] === 'reset')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// v4.11.3 — closeOnStop opt-in gate
// ---------------------------------------------------------------------------
describe('git-autopilot-close — closeOnStop gate (v4.11.3)', () => {
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

  it('should skip commit/squash/push when closeOnStop is false (default)', async () => {
    // Per-repo config has closeOnStop omitted → falls through to artibot.config
    // → also missing → readCloseOnStopFlag returns false → early return.
    setupEnabledRepo({ closeOnStop: false });
    const recorded = [];
    mockState.execFileSyncImpl = (file, args) => {
      recorded.push(args);
      const joined = (args || []).join(' ');
      if (joined === 'rev-parse --show-toplevel') return '/repo';
      if (joined === 'config --get remote.origin.url') {
        return 'https://github.com/Yoodaddy0311/artibot.git';
      }
      if (joined === 'branch --show-current') return 'artibot/master';
      if (joined.startsWith('status --porcelain')) return 'M file.js\n';
      return '';
    };

    await runHook();

    const logs = stderrSpy.mock.calls.map(([m]) => m).join('');
    expect(logs).toContain('closeOnStop=false — skipping');
    // Verify no commit/push/reset was attempted: the only git invocations
    // allowed are repo-detection (rev-parse) and the allowlist probe
    // (config --get remote.origin.url). Anything else means the gate leaked.
    const writeAttempts = recorded.filter((args) => {
      const cmd = (args && args[0]) || '';
      return ['add', 'commit', 'push', 'reset', 'status'].includes(cmd);
    });
    expect(writeAttempts).toEqual([]);
  });

  it('should respect per-repo closeOnStop=true even when artibot.config sets false', async () => {
    // Per-repo true takes precedence over plugin-wide false → pipeline runs.
    setupEnabledRepo({ closeOnStop: true, autoPushOnStop: false, squashWipOnClose: false });
    mockState.readFileSyncImpl = (p) => {
      const ps = String(p);
      if (ps.includes('autopilot.json')) {
        return JSON.stringify({
          enabled: true,
          closeOnStop: true,
          autoPullOnSession: true,
          autoPushOnStop: false,
          squashWipOnClose: false,
          branchPrefix: 'artibot/',
        });
      }
      if (ps.includes('artibot.config.json')) {
        return JSON.stringify({
          git: { autopilot: { closeOnStop: false } },
        });
      }
      throw new Error('ENOENT');
    };

    const recorded = [];
    mockState.execFileSyncImpl = (file, args) => {
      recorded.push(args);
      const joined = (args || []).join(' ');
      if (joined === 'rev-parse --show-toplevel') return '/repo';
      if (joined === 'config --get remote.origin.url') {
        return 'https://github.com/Yoodaddy0311/artibot.git';
      }
      if (joined === 'branch --show-current') return 'main';
      if (joined.startsWith('status --porcelain')) return 'M file.js\n';
      return '';
    };

    await runHook();
    const logs = stderrSpy.mock.calls.map(([m]) => m).join('');
    expect(logs).toContain('Final changes committed');
    expect(recorded.some((a) => a.join(' ') === 'add -A')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// v4.14.0 — commitStrategy: "semantic" (phase-based semantic commits)
// ---------------------------------------------------------------------------
describe('git-autopilot-close — commitStrategy: "semantic"', () => {
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

  /**
   * Set up a repo with commitStrategy: "semantic" in per-repo config.
   * hookData is passed via readStdin. Phase state file is controlled via
   * readFileSyncImpl returning the autopilot-state.json contents.
   */
  function setupSemanticRepo(hookData = {}, overrides = {}) {
    const config = {
      enabled: true,
      autoPullOnSession: true,
      autoPushOnStop: false,
      squashWipOnClose: false,
      branchPrefix: 'artibot/',
      commitStrategy: 'semantic',
      semanticCommit: {
        enabled: true,
        commitOnPhases: ['PLAN', 'EXECUTE', 'VERIFY', 'REPORT'],
        requireTestPass: true,
        requireLintClean: true,
      },
      ...overrides,
    };

    mockState.readStdinResult = Promise.resolve(JSON.stringify(hookData));
    mockState.existsSyncResults = { 'autopilot.json': true };
    mockState.stateFileContent = null;
    mockState.readFileSyncImpl = (p) => {
      const ps = String(p);
      if (ps.includes('autopilot-state.json')) {
        if (mockState.stateFileContent) return mockState.stateFileContent;
        throw new Error('ENOENT');
      }
      if (ps.includes('autopilot.json') && !ps.includes('artibot.config')) return JSON.stringify(config);
      if (ps.includes('artibot.config.json')) {
        return JSON.stringify({ git: { autopilot: {} } });
      }
      throw new Error('ENOENT');
    };

    return config;
  }

  it('should skip commit when hookData has no phase (non-autopilot turn)', async () => {
    setupSemanticRepo({}); // no phase in hookData
    mockState.execFileSyncImpl = makeExec([
      ['rev-parse --show-toplevel', '/repo'],
      ['branch --show-current', 'main'],
      ['status --porcelain', 'M file.js\n'],
    ]);

    await runHook();
    const logs = stderrSpy.mock.calls.map(([m]) => m).join('');
    expect(logs).toContain('no phase transition — skipping commit');
  });

  it('should skip commit on first phase entry (no completed phase yet)', async () => {
    setupSemanticRepo({ phase: 'PLAN' }); // first run, no state file
    mockState.execFileSyncImpl = makeExec([
      ['rev-parse --show-toplevel', '/repo'],
      ['branch --show-current', 'main'],
      ['status --porcelain', 'M file.js\n'],
    ]);

    await runHook();
    const logs = stderrSpy.mock.calls.map(([m]) => m).join('');
    expect(logs).toContain('first phase entered');
  });

  it('should create semantic commit when phase transitions (PLAN -> EXECUTE)', async () => {
    setupSemanticRepo({ phase: 'EXECUTE' });
    mockState.stateFileContent = JSON.stringify({ lastPhase: 'PLAN' });

    const recorded = [];
    mockState.execFileSyncImpl = (file, args) => {
      recorded.push(args);
      const joined = (args || []).join(' ');
      if (joined === 'rev-parse --show-toplevel') return '/repo';
      if (joined === 'config --get remote.origin.url') {
        return 'https://github.com/Yoodaddy0311/artibot.git';
      }
      if (joined === 'branch --show-current') return 'main';
      if (joined.startsWith('status --porcelain')) return 'M file.js\n';
      if (joined.includes('diff --stat')) return ' src/app.js | 3 +++\n 1 file changed, 3 insertions(+)';
      return '';
    };

    await runHook();
    const logs = stderrSpy.mock.calls.map(([m]) => m).join('');
    expect(logs).toContain('Semantic commit: PLAN phase complete');
    expect(recorded.some((a) => a.join(' ') === 'add -A')).toBe(true);
    expect(recorded.some((a) => a[0] === 'commit')).toBe(true);
    const commitArgs = recorded.find((a) => a[0] === 'commit');
    expect(commitArgs).toBeTruthy();
    expect(commitArgs[2]).toContain('docs(autopilot)');
    expect(commitArgs[2]).toContain('[PLAN complete]');
  });

  it('should use feat(autopilot) for EXECUTE phase completion', async () => {
    setupSemanticRepo({ phase: 'VERIFY' });
    mockState.stateFileContent = JSON.stringify({ lastPhase: 'EXECUTE' });

    const recorded = [];
    mockState.execFileSyncImpl = (file, args) => {
      recorded.push(args);
      const joined = (args || []).join(' ');
      if (joined === 'rev-parse --show-toplevel') return '/repo';
      if (joined === 'config --get remote.origin.url') {
        return 'https://github.com/Yoodaddy0311/artibot.git';
      }
      if (joined === 'branch --show-current') return 'main';
      if (joined.startsWith('status --porcelain')) return 'M file.js\n';
      if (joined.includes('diff --stat')) return ' src/index.js | 10 +++++++\n 1 file changed';
      return '';
    };

    await runHook();
    const commitArgs = recorded.find((a) => a[0] === 'commit');
    expect(commitArgs).toBeTruthy();
    expect(commitArgs[2]).toContain('feat(autopilot)');
    expect(commitArgs[2]).toContain('[EXECUTE complete]');
  });

  it('should skip commit when phase not in commitOnPhases', async () => {
    setupSemanticRepo({ phase: 'PLAN' });
    mockState.stateFileContent = JSON.stringify({ lastPhase: 'INTAKE' });

    mockState.execFileSyncImpl = makeExec([
      ['rev-parse --show-toplevel', '/repo'],
      ['branch --show-current', 'main'],
      ['status --porcelain', 'M file.js\n'],
    ]);

    await runHook();
    const logs = stderrSpy.mock.calls.map(([m]) => m).join('');
    expect(logs).toContain('phase INTAKE not in commitOnPhases');
  });

  it('should skip commit when no changes (workspace clean)', async () => {
    setupSemanticRepo({ phase: 'EXECUTE' });
    mockState.stateFileContent = JSON.stringify({ lastPhase: 'PLAN' });

    mockState.execFileSyncImpl = makeExec([
      ['rev-parse --show-toplevel', '/repo'],
      ['branch --show-current', 'main'],
      ['status --porcelain', ''],
    ]);

    await runHook();
    const logs = stderrSpy.mock.calls.map(([m]) => m).join('');
    expect(logs).toContain('completed but no changes to commit');
  });

  it('should skip commit when same phase repeated (no transition)', async () => {
    setupSemanticRepo({ phase: 'EXECUTE' });
    mockState.stateFileContent = JSON.stringify({ lastPhase: 'EXECUTE' });

    mockState.execFileSyncImpl = makeExec([
      ['rev-parse --show-toplevel', '/repo'],
      ['branch --show-current', 'main'],
      ['status --porcelain', 'M file.js\n'],
    ]);

    await runHook();
    const logs = stderrSpy.mock.calls.map(([m]) => m).join('');
    expect(logs).toContain('no phase transition — skipping commit');
  });

  it('should ignore closeOnStop flag for semantic strategy', async () => {
    setupSemanticRepo({ phase: 'EXECUTE' }, { closeOnStop: false });
    mockState.stateFileContent = JSON.stringify({ lastPhase: 'PLAN' });

    const recorded = [];
    mockState.execFileSyncImpl = (file, args) => {
      recorded.push(args);
      const joined = (args || []).join(' ');
      if (joined === 'rev-parse --show-toplevel') return '/repo';
      if (joined === 'config --get remote.origin.url') {
        return 'https://github.com/Yoodaddy0311/artibot.git';
      }
      if (joined === 'branch --show-current') return 'main';
      if (joined.startsWith('status --porcelain')) return 'M file.js\n';
      if (joined.includes('diff --stat')) return ' file.js | 1 +\n 1 file changed';
      return '';
    };

    await runHook();
    const logs = stderrSpy.mock.calls.map(([m]) => m).join('');
    expect(logs).not.toContain('closeOnStop=false');
    expect(logs).toContain('Semantic commit: PLAN phase complete');
    expect(recorded.some((a) => a[0] === 'commit')).toBe(true);
  });

  it('should push after semantic commit when autoPushOnStop=true', async () => {
    setupSemanticRepo({ phase: 'EXECUTE' }, { autoPushOnStop: true });
    mockState.stateFileContent = JSON.stringify({ lastPhase: 'PLAN' });

    const recorded = [];
    mockState.execFileSyncImpl = (file, args) => {
      recorded.push(args);
      const joined = (args || []).join(' ');
      if (joined === 'rev-parse --show-toplevel') return '/repo';
      if (joined === 'config --get remote.origin.url') {
        return 'https://github.com/Yoodaddy0311/artibot.git';
      }
      if (joined === 'branch --show-current') return 'main';
      if (joined.startsWith('status --porcelain')) return 'M file.js\n';
      if (joined.includes('diff --stat')) return ' file.js | 1 +\n 1 file changed';
      return '';
    };

    await runHook();
    const logs = stderrSpy.mock.calls.map(([m]) => m).join('');
    expect(logs).toContain('Pushed');
    expect(recorded.some((a) => a[0] === 'push')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// v4.14.0 — commitStrategy: "none"
// ---------------------------------------------------------------------------
describe('git-autopilot-close — commitStrategy: "none"', () => {
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

  it('should skip all git writes when commitStrategy is "none"', async () => {
    const config = {
      enabled: true,
      commitStrategy: 'none',
    };
    mockState.existsSyncResults = { 'autopilot.json': true };
    mockState.readFileSyncImpl = (p) => {
      const ps = String(p);
      if (ps.includes('autopilot.json') && !ps.includes('artibot.config')) return JSON.stringify(config);
      if (ps.includes('artibot.config.json')) return JSON.stringify({});
      throw new Error('ENOENT');
    };

    const recorded = [];
    mockState.execFileSyncImpl = (file, args) => {
      recorded.push(args);
      const joined = (args || []).join(' ');
      if (joined === 'rev-parse --show-toplevel') return '/repo';
      if (joined === 'config --get remote.origin.url') {
        return 'https://github.com/Yoodaddy0311/artibot.git';
      }
      if (joined.startsWith('status --porcelain')) return 'M file.js\n';
      return '';
    };

    await runHook();
    const logs = stderrSpy.mock.calls.map(([m]) => m).join('');
    expect(logs).toContain('commitStrategy=none — skipping all git writes');
    const writeAttempts = recorded.filter((args) => {
      const cmd = (args && args[0]) || '';
      return ['add', 'commit', 'push', 'reset'].includes(cmd);
    });
    expect(writeAttempts).toEqual([]);
  });

  it('direct-run guard: importing the module runs no git command', async () => {
    // setupEnabledRepo() opts into the full close pipeline (commit, WIP squash
    // via `reset --soft`, push). Importing must still run nothing: without the
    // guard, `main()` blocks on stdin and then rewrites and publishes the real
    // repo. Only the mocks stood between an import and a live `git push`.
    setupEnabledRepo();
    const recorded = [];
    mockState.execFileSyncImpl = (_file, args) => {
      recorded.push(args);
      return '';
    };

    await import('../../scripts/hooks/git-autopilot-close.js');
    await new Promise((r) => setTimeout(r, 30));

    expect(recorded).toEqual([]);
  });
});
