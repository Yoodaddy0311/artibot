import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * git-autopilot-close.js — Stop hook that commits, squashes WIP, and pushes.
 * Tests focus on the squashWipCommits parseInt NaN guard and overall flow.
 */

// ---------------------------------------------------------------------------
// Shared mock state
// ---------------------------------------------------------------------------
const mockState = {
  readStdinResult: Promise.resolve('{}'),
  existsSyncResults: {},
  readFileSyncImpl: () => { throw new Error('ENOENT'); },
  execSyncImpl: () => '',
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
  createErrorHandler: vi.fn(() => () => {}),
  logHookError: vi.fn(),
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual('node:fs');
  return {
    ...actual,
    existsSync: vi.fn((p) => {
      for (const [key, val] of Object.entries(mockState.existsSyncResults)) {
        if (p.includes(key)) return val;
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
}

function setupEnabledRepo(overrides = {}) {
  const config = {
    enabled: true,
    autoPullOnSession: true,
    autoPushOnStop: true,
    squashWipOnClose: true,
    branchPrefix: 'artibot/',
    ...overrides,
  };

  mockState.existsSyncResults = { 'autopilot.json': true };
  mockState.readFileSyncImpl = (p) => {
    if (p.includes('autopilot.json')) return JSON.stringify(config);
    throw new Error('ENOENT');
  };

  return config;
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
    mockState.execSyncImpl = (cmd) => {
      if (cmd === 'git rev-parse --show-toplevel') throw new Error('not a repo');
      return '';
    };

    await import('../../scripts/hooks/git-autopilot-close.js');
    const logs = stderrSpy.mock.calls.map(([m]) => m).join('');
    expect(logs).not.toContain('commit');
  });

  it('should skip when config is missing', async () => {
    mockState.execSyncImpl = (cmd) => {
      if (cmd === 'git rev-parse --show-toplevel') return '/repo';
      return '';
    };
    mockState.existsSyncResults = { 'autopilot.json': false };

    await import('../../scripts/hooks/git-autopilot-close.js');
    const logs = stderrSpy.mock.calls.map(([m]) => m).join('');
    expect(logs).not.toContain('commit');
  });

  it('should commit when workspace is dirty', async () => {
    setupEnabledRepo({ autoPushOnStop: false, squashWipOnClose: false });
    const commands = [];
    mockState.execSyncImpl = (cmd) => {
      commands.push(cmd);
      if (cmd === 'git rev-parse --show-toplevel') return '/repo';
      if (cmd === 'git branch --show-current') return 'main';
      if (cmd === 'git status --porcelain') return 'M file.js\n';
      return '';
    };

    await import('../../scripts/hooks/git-autopilot-close.js');
    expect(commands).toContain('git add -A');
    const logs = stderrSpy.mock.calls.map(([m]) => m).join('');
    expect(logs).toContain('Final changes committed');
  });

  it('should log "No uncommitted changes" when workspace is clean', async () => {
    setupEnabledRepo({ autoPushOnStop: false, squashWipOnClose: false });
    mockState.execSyncImpl = (cmd) => {
      if (cmd === 'git rev-parse --show-toplevel') return '/repo';
      if (cmd === 'git branch --show-current') return 'main';
      if (cmd === 'git status --porcelain') return '';
      return '';
    };

    await import('../../scripts/hooks/git-autopilot-close.js');
    const logs = stderrSpy.mock.calls.map(([m]) => m).join('');
    expect(logs).toContain('No uncommitted changes');
  });

  it('should handle NaN from rev-list --count gracefully', async () => {
    setupEnabledRepo({ autoPushOnStop: false });
    mockState.execSyncImpl = (cmd) => {
      if (cmd === 'git rev-parse --show-toplevel') return '/repo';
      if (cmd === 'git branch --show-current') return 'artibot/master';
      if (cmd === 'git status --porcelain') return '';
      if (cmd.includes('merge-base')) return 'abc123';
      if (cmd.includes('--grep')) return 'line1\nline2\nline3\n';
      // Return garbage for rev-list --count to trigger NaN
      if (cmd.includes('rev-list --count')) return 'not-a-number';
      return '';
    };

    await import('../../scripts/hooks/git-autopilot-close.js');
    // Should NOT crash — NaN guard should skip squash
    const logs = stderrSpy.mock.calls.map(([m]) => m).join('');
    // Squash is attempted (wipCount > 0) but squashWipCommits returns true early
    expect(logs).toContain('Squashed');
  });

  it('should squash WIP commits on autopilot branch', async () => {
    setupEnabledRepo({ autoPushOnStop: false });
    const commands = [];
    mockState.execSyncImpl = (cmd) => {
      commands.push(cmd);
      if (cmd === 'git rev-parse --show-toplevel') return '/repo';
      if (cmd === 'git branch --show-current') return 'artibot/master';
      if (cmd === 'git status --porcelain') return '';
      if (cmd.includes('merge-base')) return 'abc123';
      if (cmd.includes('--grep')) return 'aaa wip\nbbb wip\nccc wip\n';
      if (cmd.includes('rev-list --count')) return '5';
      return '';
    };

    await import('../../scripts/hooks/git-autopilot-close.js');
    const logs = stderrSpy.mock.calls.map(([m]) => m).join('');
    expect(logs).toContain('Squashed');
    expect(commands.some((c) => c.includes('git reset --soft'))).toBe(true);
  });

  it('should skip squash when not on autopilot branch', async () => {
    setupEnabledRepo({ autoPushOnStop: false });
    mockState.execSyncImpl = (cmd) => {
      if (cmd === 'git rev-parse --show-toplevel') return '/repo';
      if (cmd === 'git branch --show-current') return 'main';
      if (cmd === 'git status --porcelain') return '';
      return '';
    };

    await import('../../scripts/hooks/git-autopilot-close.js');
    const logs = stderrSpy.mock.calls.map(([m]) => m).join('');
    expect(logs).not.toContain('Squashed');
  });

  it('should push branch when autoPushOnStop is true', async () => {
    setupEnabledRepo();
    const commands = [];
    mockState.execSyncImpl = (cmd) => {
      commands.push(cmd);
      if (cmd === 'git rev-parse --show-toplevel') return '/repo';
      if (cmd === 'git branch --show-current') return 'artibot/master';
      if (cmd === 'git status --porcelain') return '';
      if (cmd.includes('merge-base')) return 'abc123';
      if (cmd.includes('--grep')) return '';
      return '';
    };

    await import('../../scripts/hooks/git-autopilot-close.js');
    const logs = stderrSpy.mock.calls.map(([m]) => m).join('');
    expect(logs).toContain('Pushed');
    expect(commands.some((c) => c.includes('git push'))).toBe(true);
  });

  it('should retry push with -u on first push failure', async () => {
    setupEnabledRepo();
    let pushAttempt = 0;
    mockState.execSyncImpl = (cmd) => {
      if (cmd === 'git rev-parse --show-toplevel') return '/repo';
      if (cmd === 'git branch --show-current') return 'artibot/master';
      if (cmd === 'git status --porcelain') return '';
      if (cmd.includes('merge-base')) return 'abc123';
      if (cmd.includes('--grep')) return '';
      if (cmd.startsWith('git push origin')) {
        pushAttempt++;
        if (pushAttempt === 1) throw new Error('no upstream');
        return '';
      }
      if (cmd.startsWith('git push -u')) return '';
      return '';
    };

    await import('../../scripts/hooks/git-autopilot-close.js');
    const logs = stderrSpy.mock.calls.map(([m]) => m).join('');
    expect(logs).toContain('Pushed');
  });

  it('should log push failure when both push attempts fail', async () => {
    setupEnabledRepo();
    mockState.execSyncImpl = (cmd) => {
      if (cmd === 'git rev-parse --show-toplevel') return '/repo';
      if (cmd === 'git branch --show-current') return 'artibot/master';
      if (cmd === 'git status --porcelain') return '';
      if (cmd.includes('merge-base')) return 'abc123';
      if (cmd.includes('--grep')) return '';
      if (cmd.includes('git push')) throw new Error('push failed');
      return '';
    };

    await import('../../scripts/hooks/git-autopilot-close.js');
    const logs = stderrSpy.mock.calls.map(([m]) => m).join('');
    expect(logs).toContain('Push failed');
  });
});
