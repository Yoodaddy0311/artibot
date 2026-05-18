import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Integration tests for scripts/hooks/session-notes.js.
 *
 * Covers:
 *   - Allowlist gate (non-allowed repos → zero writes)
 *   - shouldSkipEntry path (empty session → no file mutation)
 *   - Happy path: commits + files → entry appended + state saved
 *   - First-run path (no state) → uses lookback window
 *   - WIP-squashed detection from commit messages
 */

const mockState = {
  readStdinResult: Promise.resolve('{}'),
  existsSyncResults: {},
  readFileSyncImpl: () => { throw new Error('ENOENT'); },
  execFileSyncImpl: () => '',
  writeFiles: [],
  appendFiles: [],
  mkdirCalls: [],
  allowed: true,
};

vi.mock('../../scripts/utils/index.js', () => ({
  readStdin: vi.fn(() => mockState.readStdinResult),
  parseJSON: vi.fn((s) => {
    try { return JSON.parse(s); } catch { return null; }
  }),
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
    writeFileSync: vi.fn((p, data) => {
      mockState.writeFiles.push({ path: String(p), data: String(data) });
    }),
    appendFileSync: vi.fn((p, data) => {
      mockState.appendFiles.push({ path: String(p), data: String(data) });
    }),
    mkdirSync: vi.fn((p, opts) => {
      mockState.mkdirCalls.push({ path: String(p), opts });
    }),
  };
});

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn((file, argv = [], opts) => {
    const joined = `${file} ${argv.join(' ')}`.trim();
    return mockState.execFileSyncImpl(joined, opts);
  }),
}));

function resetState() {
  mockState.readStdinResult = Promise.resolve('{}');
  mockState.existsSyncResults = {};
  mockState.readFileSyncImpl = () => { throw new Error('ENOENT'); };
  mockState.execFileSyncImpl = () => '';
  mockState.writeFiles = [];
  mockState.appendFiles = [];
  mockState.mkdirCalls = [];
  mockState.allowed = true;
}

describe('session-notes hook', () => {
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

  it('skips silently when not in a git repo', async () => {
    mockState.execFileSyncImpl = (cmd) => {
      if (cmd === 'git rev-parse --show-toplevel') throw new Error('not a repo');
      return '';
    };

    await import('../../scripts/hooks/session-notes.js');
    expect(mockState.appendFiles).toHaveLength(0);
    expect(mockState.writeFiles).toHaveLength(0);
  });

  it('skips writes when repo is not in autopilot allowlist', async () => {
    mockState.allowed = false;
    mockState.execFileSyncImpl = (cmd) => {
      if (cmd === 'git rev-parse --show-toplevel') return '/repo';
      return '';
    };

    await import('../../scripts/hooks/session-notes.js');
    expect(mockState.appendFiles).toHaveLength(0);
  });

  it('skips append when session had no commits and no file changes', async () => {
    mockState.execFileSyncImpl = (cmd) => {
      if (cmd === 'git rev-parse --show-toplevel') return '/repo';
      if (cmd.startsWith('git log')) return ''; // no commits
      if (cmd.startsWith('git diff')) return ''; // no files
      if (cmd === 'git branch --show-current') return 'artibot/master';
      return '';
    };
    // Prior state exists so collectCommits uses the range form
    mockState.existsSyncResults = { 'session-notes-state.json': true };
    mockState.readFileSyncImpl = () => JSON.stringify({ lastSeenSha: 'oldsha123' });

    await import('../../scripts/hooks/session-notes.js');
    expect(mockState.appendFiles).toHaveLength(0);
  });

  it('appends entry + writes header on first run with commits', async () => {
    const commits = [
      'aaaa111\tfix(autopilot): drift fix',
      'bbbb222\tdocs(prd): telegram MCP PRD',
    ].join('\n');

    mockState.execFileSyncImpl = (cmd) => {
      if (cmd === 'git rev-parse --show-toplevel') return '/repo';
      if (cmd.startsWith('git log HEAD')) return commits;
      if (cmd.startsWith('git diff')) return '';
      if (cmd === 'git branch --show-current') return 'artibot/master';
      if (cmd === 'git rev-parse HEAD') return 'aaaa111';
      return '';
    };
    // No state file → first-run path; no notes file → header written
    mockState.existsSyncResults = {};

    await import('../../scripts/hooks/session-notes.js');

    // Header was written on first ever run
    const headerWrite = mockState.writeFiles.find((w) => w.path.includes('SESSION-NOTES.md'));
    expect(headerWrite).toBeDefined();
    expect(headerWrite.data).toContain('# Artibot Session Notes');

    // Entry was appended
    const entryAppend = mockState.appendFiles.find((a) => a.path.includes('SESSION-NOTES.md'));
    expect(entryAppend).toBeDefined();
    expect(entryAppend.data).toContain('`aaaa111` fix(autopilot): drift fix');

    // State was persisted with HEAD SHA
    const stateWrite = mockState.writeFiles.find((w) => w.path.includes('session-notes-state.json'));
    expect(stateWrite).toBeDefined();
    expect(stateWrite.data).toContain('aaaa111');
  });

  it('counts files changed via git diff between lastSeenSha and HEAD', async () => {
    mockState.execFileSyncImpl = (cmd) => {
      if (cmd === 'git rev-parse --show-toplevel') return '/repo';
      if (cmd.includes('log oldsha..HEAD')) return 'newsha1\tfeat: x';
      if (cmd === 'git diff --name-only oldsha..HEAD') {
        return 'src/a.js\nsrc/b.js\nsrc/c.js';
      }
      if (cmd === 'git branch --show-current') return 'artibot/master';
      if (cmd === 'git rev-parse HEAD') return 'newsha1';
      return '';
    };
    mockState.existsSyncResults = { 'session-notes-state.json': true };
    mockState.readFileSyncImpl = () => JSON.stringify({ lastSeenSha: 'oldsha' });

    await import('../../scripts/hooks/session-notes.js');

    const entryAppend = mockState.appendFiles.find((a) => a.path.includes('SESSION-NOTES.md'));
    expect(entryAppend.data).toContain('**Files touched**: 3');
  });

  it('detects WIP-squashed count from commit body marker', async () => {
    mockState.execFileSyncImpl = (cmd) => {
      if (cmd === 'git rev-parse --show-toplevel') return '/repo';
      if (cmd.startsWith('git log oldsha..HEAD --format=%H')) {
        return 'newsha1\tchore: session close (squashed)';
      }
      if (cmd.startsWith('git log oldsha..HEAD --format=%B')) {
        return 'chore: session close\n\nIncludes 5 WIP commits squashed into clean commit';
      }
      if (cmd.startsWith('git diff')) return 'file.js';
      if (cmd === 'git branch --show-current') return 'artibot/master';
      if (cmd === 'git rev-parse HEAD') return 'newsha1';
      return '';
    };
    mockState.existsSyncResults = { 'session-notes-state.json': true };
    mockState.readFileSyncImpl = () => JSON.stringify({ lastSeenSha: 'oldsha' });

    await import('../../scripts/hooks/session-notes.js');

    const entryAppend = mockState.appendFiles.find((a) => a.path.includes('SESSION-NOTES.md'));
    expect(entryAppend.data).toContain('**WIP commits squashed**: 5');
  });
});
