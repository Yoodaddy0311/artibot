import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * git-autopilot-session.js — SessionStart hook that auto-pulls and
 * switches to the autopilot branch. Tests cover the pull/rebase logic
 * including the isRebaseInProgress guard added to prevent rebase --continue
 * on non-rebase failures.
 */

// ---------------------------------------------------------------------------
// Shared mock state
// ---------------------------------------------------------------------------
const mockState = {
  readStdinResult: Promise.resolve('{}'),
  existsSyncResults: {},
  readFileSyncImpl: () => { throw new Error('ENOENT'); },
  execSyncImpl: () => '',
  autoResolveResult: { results: [], allResolved: true },
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
}));

vi.mock('../../lib/core/hook-utils.js', () => ({
  createErrorHandler: vi.fn(() => (err) => {
    process.stderr.write(`[test-error] ${err.message}\n`);
    // Don't exit in tests
  }),
}));

vi.mock('../../scripts/hooks/git-autopilot-merge.js', () => ({
  autoResolveAll: vi.fn(() => mockState.autoResolveResult),
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual('node:fs');
  return {
    ...actual,
    existsSync: vi.fn((p) => {
      // Check specific paths in mockState
      for (const [key, val] of Object.entries(mockState.existsSyncResults)) {
        if (p.includes(key)) return val;
      }
      return false;
    }),
    readFileSync: vi.fn((...args) => mockState.readFileSyncImpl(...args)),
  };
});

// Squad A converted session.js to argv-array execFileSync. We adapt the mock
// by joining argv back into the same string form the existing matchers use,
// so test cases like `cmd === 'git rev-parse --show-toplevel'` keep working.
vi.mock('node:child_process', () => ({
  execSync: vi.fn((...args) => mockState.execSyncImpl(...args)),
  execFileSync: vi.fn((file, argv = [], opts) => {
    const joined = `${file} ${argv.join(' ')}`.trim();
    return mockState.execSyncImpl(joined, opts);
  }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Reset mock state for each test. */
function resetState() {
  mockState.readStdinResult = Promise.resolve('{}');
  mockState.existsSyncResults = {};
  mockState.readFileSyncImpl = () => { throw new Error('ENOENT'); };
  mockState.execSyncImpl = () => '';
  mockState.autoResolveResult = { results: [], allResolved: true };
}

/** Configure mocks for a standard autopilot-enabled repo. */
function setupEnabledRepo() {
  const config = {
    enabled: true,
    autoPullOnSession: true,
    branchPrefix: 'artibot/',
  };

  mockState.execSyncImpl = (cmd) => {
    if (cmd === 'git rev-parse --show-toplevel') return '/repo';
    if (cmd === 'git config --get remote.origin.url') {
      return 'https://github.com/Yoodaddy0311/artibot.git';
    }
    if (cmd === 'git branch --show-current') return 'artibot/master';
    if (cmd === 'git rev-parse --git-dir') return '.git';
    if (cmd.startsWith('git pull')) return '';
    if (cmd.startsWith('git show-ref')) return '';
    if (cmd.startsWith('git checkout')) return '';
    return '';
  };

  mockState.existsSyncResults = {
    'autopilot.json': true,
  };

  mockState.readFileSyncImpl = (p) => {
    if (p.includes('autopilot.json')) return JSON.stringify(config);
    throw new Error('ENOENT');
  };

  return config;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('git-autopilot-session', () => {
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
    mockState.execSyncImpl = (cmd) => {
      if (cmd === 'git rev-parse --show-toplevel') throw new Error('not a repo');
      return '';
    };

    await import('../../scripts/hooks/git-autopilot-session.js');
    // Should not throw, no stderr output about pull
    const pullLogs = stderrSpy.mock.calls
      .map(([msg]) => msg)
      .filter((m) => m.includes('pull'));
    expect(pullLogs).toHaveLength(0);
  });

  it('should skip when autopilot config is missing', async () => {
    mockState.execSyncImpl = (cmd) => {
      if (cmd === 'git rev-parse --show-toplevel') return '/repo';
      return '';
    };
    mockState.existsSyncResults = { 'autopilot.json': false };

    await import('../../scripts/hooks/git-autopilot-session.js');
    const pullLogs = stderrSpy.mock.calls
      .map(([msg]) => msg)
      .filter((m) => m.includes('pull'));
    expect(pullLogs).toHaveLength(0);
  });

  it('should skip when autopilot is disabled', async () => {
    mockState.execSyncImpl = (cmd) => {
      if (cmd === 'git rev-parse --show-toplevel') return '/repo';
      return '';
    };
    mockState.existsSyncResults = { 'autopilot.json': true };
    mockState.readFileSyncImpl = () => JSON.stringify({ enabled: false });

    await import('../../scripts/hooks/git-autopilot-session.js');
    const pullLogs = stderrSpy.mock.calls
      .map(([msg]) => msg)
      .filter((m) => m.includes('pull'));
    expect(pullLogs).toHaveLength(0);
  });

  it('should log success when pull succeeds', async () => {
    setupEnabledRepo();

    await import('../../scripts/hooks/git-autopilot-session.js');
    const logs = stderrSpy.mock.calls.map(([msg]) => msg).join('');
    expect(logs).toContain('Pulled latest changes');
  });

  it('should skip conflict resolution when pull fails but no rebase in progress', async () => {
    setupEnabledRepo();
    mockState.execSyncImpl = (cmd) => {
      if (cmd === 'git rev-parse --show-toplevel') return '/repo';
      if (cmd === 'git config --get remote.origin.url') {
        return 'https://github.com/Yoodaddy0311/artibot.git';
      }
      if (cmd === 'git branch --show-current') return 'artibot/master';
      if (cmd === 'git rev-parse --git-dir') return '.git';
      if (cmd.startsWith('git pull')) throw new Error('pull failed');
      return '';
    };
    // No rebase-merge or rebase-apply dirs
    mockState.existsSyncResults = {
      'autopilot.json': true,
      'rebase-merge': false,
      'rebase-apply': false,
    };

    await import('../../scripts/hooks/git-autopilot-session.js');
    const logs = stderrSpy.mock.calls.map(([msg]) => msg).join('');
    expect(logs).toContain('no rebase in progress');
    expect(logs).not.toContain('attempting conflict auto-resolution');
  });

  it('should attempt conflict resolution when pull fails and rebase is in progress', async () => {
    setupEnabledRepo();
    const commands = [];
    mockState.execSyncImpl = (cmd) => {
      commands.push(cmd);
      if (cmd === 'git rev-parse --show-toplevel') return '/repo';
      if (cmd === 'git config --get remote.origin.url') {
        return 'https://github.com/Yoodaddy0311/artibot.git';
      }
      if (cmd === 'git branch --show-current') return 'artibot/master';
      if (cmd === 'git rev-parse --git-dir') return '.git';
      if (cmd.startsWith('git pull')) throw new Error('pull failed');
      if (cmd.startsWith('git rebase --continue')) return '';
      return '';
    };
    mockState.existsSyncResults = {
      'autopilot.json': true,
      'rebase-merge': true,
    };
    mockState.autoResolveResult = {
      results: [{ filePath: 'file.js', resolved: true }],
      allResolved: true,
    };

    await import('../../scripts/hooks/git-autopilot-session.js');
    const logs = stderrSpy.mock.calls.map(([msg]) => msg).join('');
    expect(logs).toContain('attempting conflict auto-resolution');
    expect(logs).toContain('Auto-resolved 1 conflict(s)');
    expect(commands).toContain('git rebase --continue');
  });

  it('should abort stale rebase when in rebase state but no conflicts found', async () => {
    setupEnabledRepo();
    const commands = [];
    mockState.execSyncImpl = (cmd) => {
      commands.push(cmd);
      if (cmd === 'git rev-parse --show-toplevel') return '/repo';
      if (cmd === 'git config --get remote.origin.url') {
        return 'https://github.com/Yoodaddy0311/artibot.git';
      }
      if (cmd === 'git branch --show-current') return 'artibot/master';
      if (cmd === 'git rev-parse --git-dir') return '.git';
      if (cmd.startsWith('git pull')) throw new Error('pull failed');
      if (cmd.startsWith('git rebase --abort')) return '';
      return '';
    };
    mockState.existsSyncResults = {
      'autopilot.json': true,
      'rebase-merge': true,
    };
    mockState.autoResolveResult = { results: [], allResolved: true };

    await import('../../scripts/hooks/git-autopilot-session.js');
    const logs = stderrSpy.mock.calls.map(([msg]) => msg).join('');
    expect(logs).toContain('aborting stale rebase');
    expect(commands).toContain('git rebase --abort');
  });

  it('should abort when rebase --continue fails', async () => {
    setupEnabledRepo();
    const commands = [];
    mockState.execSyncImpl = (cmd) => {
      commands.push(cmd);
      if (cmd === 'git rev-parse --show-toplevel') return '/repo';
      if (cmd === 'git config --get remote.origin.url') {
        return 'https://github.com/Yoodaddy0311/artibot.git';
      }
      if (cmd === 'git branch --show-current') return 'artibot/master';
      if (cmd === 'git rev-parse --git-dir') return '.git';
      if (cmd.startsWith('git pull')) throw new Error('pull failed');
      if (cmd.startsWith('git rebase --continue')) throw new Error('continue failed');
      if (cmd.startsWith('git rebase --abort')) return '';
      return '';
    };
    mockState.existsSyncResults = {
      'autopilot.json': true,
      'rebase-apply': true,
    };
    mockState.autoResolveResult = {
      results: [{ filePath: 'a.js', resolved: true }],
      allResolved: true,
    };

    await import('../../scripts/hooks/git-autopilot-session.js');
    const logs = stderrSpy.mock.calls.map(([msg]) => msg).join('');
    expect(logs).toContain('rebase --continue failed');
    expect(commands).toContain('git rebase --abort');
  });

  it('should log unresolved files when auto-resolve fails', async () => {
    setupEnabledRepo();
    mockState.execSyncImpl = (cmd) => {
      if (cmd === 'git rev-parse --show-toplevel') return '/repo';
      if (cmd === 'git config --get remote.origin.url') {
        return 'https://github.com/Yoodaddy0311/artibot.git';
      }
      if (cmd === 'git branch --show-current') return 'artibot/master';
      if (cmd === 'git rev-parse --git-dir') return '.git';
      if (cmd.startsWith('git pull')) throw new Error('pull failed');
      return '';
    };
    mockState.existsSyncResults = {
      'autopilot.json': true,
      'rebase-merge': true,
    };
    mockState.autoResolveResult = {
      results: [
        { filePath: 'a.js', resolved: true },
        { filePath: 'b.js', resolved: false },
      ],
      allResolved: false,
    };

    await import('../../scripts/hooks/git-autopilot-session.js');
    const logs = stderrSpy.mock.calls.map(([msg]) => msg).join('');
    expect(logs).toContain('Could not auto-resolve');
    expect(logs).toContain('b.js');
  });

  it('should switch to autopilot branch when not already on one', async () => {
    const commands = [];
    mockState.execSyncImpl = (cmd) => {
      commands.push(cmd);
      if (cmd === 'git rev-parse --show-toplevel') return '/repo';
      if (cmd === 'git config --get remote.origin.url') {
        return 'https://github.com/Yoodaddy0311/artibot.git';
      }
      if (cmd === 'git branch --show-current') return 'main';
      if (cmd.startsWith('git pull')) return '';
      if (cmd.startsWith('git show-ref')) throw new Error('not found');
      if (cmd.startsWith('git checkout -b')) return '';
      return '';
    };
    mockState.existsSyncResults = { 'autopilot.json': true };
    mockState.readFileSyncImpl = () => JSON.stringify({
      enabled: true,
      autoPullOnSession: true,
      branchPrefix: 'artibot/',
    });

    await import('../../scripts/hooks/git-autopilot-session.js');
    const logs = stderrSpy.mock.calls.map(([msg]) => msg).join('');
    expect(logs).toContain('Switched to autopilot branch');
    expect(commands.some((c) => c.includes('checkout -b artibot/main'))).toBe(true);
  });

  it('should stay on current branch if already on autopilot branch', async () => {
    setupEnabledRepo();

    await import('../../scripts/hooks/git-autopilot-session.js');
    const logs = stderrSpy.mock.calls.map(([msg]) => msg).join('');
    expect(logs).not.toContain('Switched to autopilot branch');
  });

  // -------------------------------------------------------------------------
  // syncFromBaseBranch — cross-machine version drift fix
  //
  // Background: autopilot's `git pull` only fetches origin/<current-branch>.
  // When another computer pushes a release to `master`, this computer's
  // `artibot/master` never sees it until manual merge. The new sync step
  // pulls origin/master into the autopilot branch automatically.
  // -------------------------------------------------------------------------
  it('merges from origin/master when autopilot branch is behind base', async () => {
    const commands = [];
    mockState.execSyncImpl = (cmd) => {
      commands.push(cmd);
      if (cmd === 'git rev-parse --show-toplevel') return '/repo';
      if (cmd === 'git config --get remote.origin.url') {
        return 'https://github.com/Yoodaddy0311/artibot.git';
      }
      if (cmd === 'git branch --show-current') return 'artibot/master';
      if (cmd === 'git rev-parse --git-dir') return '.git';
      if (cmd.startsWith('git pull')) return '';
      // resolveBaseBranch: upstream tracking returns origin/master
      if (cmd === 'git rev-parse --abbrev-ref --symbolic-full-name @{upstream}') {
        return 'origin/master';
      }
      if (cmd.includes('rev-parse --verify --quiet origin/master')) return '';
      if (cmd === 'git rev-list --count HEAD..origin/master') return '3';
      if (cmd.startsWith('git merge origin/master')) return '';
      if (cmd.startsWith('git show-ref')) return '';
      if (cmd.startsWith('git checkout')) return '';
      return '';
    };
    mockState.existsSyncResults = { 'autopilot.json': true };
    mockState.readFileSyncImpl = () => JSON.stringify({
      enabled: true,
      autoPullOnSession: true,
      branchPrefix: 'artibot/',
    });

    await import('../../scripts/hooks/git-autopilot-session.js');
    const logs = stderrSpy.mock.calls.map(([msg]) => msg).join('');
    expect(logs).toContain('Merged 3 commit(s) from base branch');
    expect(commands.some((c) => c.startsWith('git merge origin/master'))).toBe(true);
  });

  it('skips base-branch sync when current branch is not an autopilot branch', async () => {
    const commands = [];
    mockState.execSyncImpl = (cmd) => {
      commands.push(cmd);
      if (cmd === 'git rev-parse --show-toplevel') return '/repo';
      if (cmd === 'git config --get remote.origin.url') {
        return 'https://github.com/Yoodaddy0311/artibot.git';
      }
      if (cmd === 'git branch --show-current') return 'feature/foo';
      if (cmd === 'git rev-parse --git-dir') return '.git';
      if (cmd.startsWith('git pull')) return '';
      if (cmd.startsWith('git show-ref')) throw new Error('not found');
      if (cmd.startsWith('git checkout -b')) return '';
      return '';
    };
    mockState.existsSyncResults = { 'autopilot.json': true };
    mockState.readFileSyncImpl = () => JSON.stringify({
      enabled: true,
      autoPullOnSession: true,
      branchPrefix: 'artibot/',
    });

    await import('../../scripts/hooks/git-autopilot-session.js');
    // No merge attempted — feature/foo is not autopilot-prefixed
    expect(commands.some((c) => c.startsWith('git rev-list --count HEAD..origin/'))).toBe(false);
    expect(commands.some((c) => c.startsWith('git merge origin/'))).toBe(false);
  });

  it('skips base-branch sync when origin/<base> ref is missing', async () => {
    const commands = [];
    mockState.execSyncImpl = (cmd) => {
      commands.push(cmd);
      if (cmd === 'git rev-parse --show-toplevel') return '/repo';
      if (cmd === 'git config --get remote.origin.url') {
        return 'https://github.com/Yoodaddy0311/artibot.git';
      }
      if (cmd === 'git branch --show-current') return 'artibot/master';
      if (cmd === 'git rev-parse --git-dir') return '.git';
      if (cmd.startsWith('git pull')) return '';
      if (cmd === 'git rev-parse --abbrev-ref --symbolic-full-name @{upstream}') {
        return 'origin/master';
      }
      if (cmd.includes('rev-parse --verify --quiet origin/master')) {
        throw new Error('not found');
      }
      if (cmd.startsWith('git show-ref')) return '';
      return '';
    };
    mockState.existsSyncResults = { 'autopilot.json': true };
    mockState.readFileSyncImpl = () => JSON.stringify({
      enabled: true,
      autoPullOnSession: true,
      branchPrefix: 'artibot/',
    });

    await import('../../scripts/hooks/git-autopilot-session.js');
    expect(commands.some((c) => c.startsWith('git merge origin/'))).toBe(false);
  });

  it('skips base-branch sync when already in sync (ahead=0)', async () => {
    const commands = [];
    mockState.execSyncImpl = (cmd) => {
      commands.push(cmd);
      if (cmd === 'git rev-parse --show-toplevel') return '/repo';
      if (cmd === 'git config --get remote.origin.url') {
        return 'https://github.com/Yoodaddy0311/artibot.git';
      }
      if (cmd === 'git branch --show-current') return 'artibot/master';
      if (cmd === 'git rev-parse --git-dir') return '.git';
      if (cmd.startsWith('git pull')) return '';
      if (cmd === 'git rev-parse --abbrev-ref --symbolic-full-name @{upstream}') {
        return 'origin/master';
      }
      if (cmd.includes('rev-parse --verify --quiet origin/master')) return '';
      if (cmd === 'git rev-list --count HEAD..origin/master') return '0';
      if (cmd.startsWith('git show-ref')) return '';
      return '';
    };
    mockState.existsSyncResults = { 'autopilot.json': true };
    mockState.readFileSyncImpl = () => JSON.stringify({
      enabled: true,
      autoPullOnSession: true,
      branchPrefix: 'artibot/',
    });

    await import('../../scripts/hooks/git-autopilot-session.js');
    expect(commands.some((c) => c.startsWith('git merge origin/'))).toBe(false);
    const logs = stderrSpy.mock.calls.map(([msg]) => msg).join('');
    expect(logs).not.toContain('Merged ');
  });

  it('aborts merge on conflict and logs warning', async () => {
    const commands = [];
    mockState.execSyncImpl = (cmd) => {
      commands.push(cmd);
      if (cmd === 'git rev-parse --show-toplevel') return '/repo';
      if (cmd === 'git config --get remote.origin.url') {
        return 'https://github.com/Yoodaddy0311/artibot.git';
      }
      if (cmd === 'git branch --show-current') return 'artibot/master';
      if (cmd === 'git rev-parse --git-dir') return '.git';
      if (cmd.startsWith('git pull')) return '';
      if (cmd === 'git rev-parse --abbrev-ref --symbolic-full-name @{upstream}') {
        return 'origin/master';
      }
      if (cmd.includes('rev-parse --verify --quiet origin/master')) return '';
      if (cmd === 'git rev-list --count HEAD..origin/master') return '2';
      if (cmd.startsWith('git merge origin/master')) throw new Error('CONFLICT');
      if (cmd === 'git merge --abort') return '';
      if (cmd.startsWith('git show-ref')) return '';
      return '';
    };
    mockState.existsSyncResults = { 'autopilot.json': true };
    mockState.readFileSyncImpl = () => JSON.stringify({
      enabled: true,
      autoPullOnSession: true,
      branchPrefix: 'artibot/',
    });

    await import('../../scripts/hooks/git-autopilot-session.js');
    expect(commands).toContain('git merge --abort');
    const logs = stderrSpy.mock.calls.map(([msg]) => msg).join('');
    expect(logs).toContain('Base-branch sync had conflicts');
  });
});
