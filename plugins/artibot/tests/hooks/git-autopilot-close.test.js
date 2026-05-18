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
    ...overrides,
  };

  mockState.existsSyncResults = { 'autopilot.json': true };
  mockState.readFileSyncImpl = (p) => {
    if (String(p).includes('autopilot.json')) return JSON.stringify(config);
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

    await import('../../scripts/hooks/git-autopilot-close.js');
    const logs = stderrSpy.mock.calls.map(([m]) => m).join('');
    expect(logs).not.toContain('commit');
  });

  it('should skip when config is missing', async () => {
    mockState.execFileSyncImpl = makeExec([
      ['rev-parse --show-toplevel', '/repo'],
    ]);
    mockState.existsSyncResults = { 'autopilot.json': false };

    await import('../../scripts/hooks/git-autopilot-close.js');
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

    await import('../../scripts/hooks/git-autopilot-close.js');
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

    await import('../../scripts/hooks/git-autopilot-close.js');
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

    await import('../../scripts/hooks/git-autopilot-close.js');
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

    await import('../../scripts/hooks/git-autopilot-close.js');
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

    await import('../../scripts/hooks/git-autopilot-close.js');
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

    await import('../../scripts/hooks/git-autopilot-close.js');
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

    await import('../../scripts/hooks/git-autopilot-close.js');
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

    await import('../../scripts/hooks/git-autopilot-close.js');
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

    await import('../../scripts/hooks/git-autopilot-close.js');
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

    await import('../../scripts/hooks/git-autopilot-close.js');
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

    await import('../../scripts/hooks/git-autopilot-close.js');
    // No reset issued because guard short-circuits.
    expect(recorded.some((a) => a[0] === 'reset')).toBe(false);
  });
});
