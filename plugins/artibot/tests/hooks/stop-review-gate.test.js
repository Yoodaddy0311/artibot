import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * stop-review-gate.js — Stop hook that scans recent diffs for quality issues.
 *
 * Phase 2c P0 fixes covered by this test file:
 *   B-1 getChangedFiles: --diff-filter=ACMR excludes deletions; renames return new path only
 *   B-2 main(): hookData.stop_hook_active=true triggers immediate return (recursion guard)
 */

const mockState = {
  readStdinResult: Promise.resolve('{}'),
  /** Map keyed by command string (substring match) -> string output or Error to throw. */
  execSyncResponses: [],
  execLog: [],
  existsSyncResults: {},
  readFileSyncImpl: () => { throw new Error('ENOENT'); },
  writeStdoutCalls: [],
};

vi.mock('../../scripts/utils/index.js', () => ({
  readStdin: vi.fn(() => mockState.readStdinResult),
  parseJSON: vi.fn((str) => {
    try { return JSON.parse(str); }
    catch { return null; }
  }),
  writeStdout: vi.fn((payload) => {
    mockState.writeStdoutCalls.push(payload);
  }),
  getPluginRoot: vi.fn(() => '/plugin/root'),
  toFileUrl: vi.fn((p) => `file:///${p}`),
}));

vi.mock('../../lib/core/hook-utils.js', () => ({
  createErrorHandler: vi.fn(() => () => {}),
  hasExtension: vi.fn((file, set) => {
    const idx = file.lastIndexOf('.');
    if (idx < 0) return false;
    return set.has(file.slice(idx));
  }),
  isSkippablePath: vi.fn(() => false),
  logHookError: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execSync: vi.fn((cmd /*, opts */) => {
    mockState.execLog.push(cmd);
    for (const [matcher, response] of mockState.execSyncResponses) {
      if (cmd.includes(matcher)) {
        if (response instanceof Error) throw response;
        return typeof response === 'function' ? response(cmd) : response;
      }
    }
    throw new Error(`no-mock: ${cmd.slice(0, 60)}`);
  }),
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
    readdirSync: vi.fn(() => []),
  };
});

function reset() {
  mockState.readStdinResult = Promise.resolve('{}');
  mockState.execSyncResponses = [];
  mockState.execLog = [];
  mockState.existsSyncResults = {};
  mockState.readFileSyncImpl = () => { throw new Error('ENOENT'); };
  mockState.writeStdoutCalls = [];
}

let stderrSpy;

beforeEach(() => {
  vi.resetModules();
  reset();
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  stderrSpy.mockRestore();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// B-2 stop_hook_active recursion guard
// ---------------------------------------------------------------------------
describe('stop-review-gate — stop_hook_active recursion guard', () => {
  it('returns immediately without writing stdout when stop_hook_active=true', async () => {
    mockState.readStdinResult = Promise.resolve(JSON.stringify({ stop_hook_active: true }));
    // No execSync responses defined — if main() proceeds it will throw.
    await import('../../scripts/hooks/stop-review-gate.js');
    expect(mockState.writeStdoutCalls).toHaveLength(0);
    const logs = stderrSpy.mock.calls.map(([m]) => m).join('');
    // No "Not in a git repository" / "No changed files" / "Review gate" log either.
    expect(logs).not.toContain('Review gate');
    expect(logs).not.toContain('No changed files');
  });

  it('proceeds normally when stop_hook_active is absent (negative control)', async () => {
    mockState.readStdinResult = Promise.resolve(JSON.stringify({}));
    mockState.execSyncResponses = [
      ['git rev-parse --show-toplevel', '/repo'],
      // No changed files -> fast-path approve.
      ['git diff --name-status', ''],
    ];
    await import('../../scripts/hooks/stop-review-gate.js');
    expect(mockState.writeStdoutCalls).toHaveLength(1);
    expect(mockState.writeStdoutCalls[0].decision).toBe('approve');
  });
});

// ---------------------------------------------------------------------------
// B-1 getChangedFiles diff filter (deletions + renames)
// ---------------------------------------------------------------------------
describe('stop-review-gate — getChangedFiles --diff-filter=ACMR', () => {
  it('excludes deleted files and uses --diff-filter=ACMR in the git diff command', async () => {
    mockState.readStdinResult = Promise.resolve(JSON.stringify({}));
    mockState.execSyncResponses = [
      ['rev-parse --show-toplevel', '/repo'],
      // Source builds: `git diff --name-status --diff-filter=ACMR HEAD~1 HEAD ...`
      // Deletion entries (D\t...) would be filtered out by git itself; we
      // simulate that by NOT emitting any "D" rows.  Bracket-mismatch /
      // pattern checks pass on the trivial body returned by readFileSync.
      ['diff --name-status', 'M\tplugins/artibot/lib/foo.js\nA\tplugins/artibot/lib/bar.js\n'],
    ];
    mockState.existsSyncResults = {
      'plugins/artibot/lib/foo.js': true,
      'plugins/artibot/lib/bar.js': true,
      'plugins/artibot/tests': false,
      'artibot.config.json': false,
    };
    mockState.readFileSyncImpl = () => 'export const x = 1;\n';

    await import('../../scripts/hooks/stop-review-gate.js');
    // Source MUST embed --diff-filter=ACMR in its diff command (B-1 invariant).
    const diffCmds = mockState.execLog.filter((c) => c.includes('diff --name-status'));
    expect(diffCmds.length).toBeGreaterThan(0);
    expect(diffCmds.every((c) => c.includes('--diff-filter=ACMR'))).toBe(true);
    expect(mockState.writeStdoutCalls).toHaveLength(1);
  });

  it('returns the new path only for renamed entries (R<score> old new)', async () => {
    mockState.readStdinResult = Promise.resolve(JSON.stringify({}));
    mockState.execSyncResponses = [
      ['rev-parse --show-toplevel', '/repo'],
      // Rename row format: "R100\told/path.js\tnew/path.js"
      // Pattern row: "M\tregular/path.js"
      ['diff --name-status', () => {
        return 'R100\told/foo.js\tnew/foo.js\nM\tplugins/artibot/lib/regular.js\n';
      }],
    ];
    // Exists only for the new path (the old path no longer exists in HEAD).
    mockState.existsSyncResults = {
      'new/foo.js': true,
      'plugins/artibot/lib/regular.js': true,
      // ensure we don't claim old/foo.js exists
      'old/foo.js': false,
      'plugins/artibot/tests': false,
      'artibot.config.json': false,
    };
    // readFileSync should only be called for files reported as changed.
    mockState.readFileSyncImpl = (p) => {
      // record which file was opened
      const s = String(p);
      if (s.includes('new/foo.js') || s.includes('regular.js')) return 'export const x = 1;\n';
      throw new Error(`unexpected read: ${s}`);
    };

    // Spy on the writeStdout call to inspect the post-aggregation file count.
    await import('../../scripts/hooks/stop-review-gate.js');
    expect(mockState.writeStdoutCalls).toHaveLength(1);
    const reason = mockState.writeStdoutCalls[0].reason || '';
    // Approve message format: "All N changed file(s) passed review gate" — we expect 2.
    // (If review-gate finds an issue -> block, but the inputs here are clean.)
    const receivedFiles = reason.match(/(\d+)\s+changed file/);
    expect(receivedFiles?.[1]).toBe('2');
    // Crucially, the rename's old path (old/foo.js) must NOT appear as a "missing test" entry.
    expect(reason).not.toContain('old/foo.js');
  });
});
