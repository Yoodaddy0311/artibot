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
  // v4.7.4: hook now imports isArtibotRepo from hook-utils. Reuse the same
  // existsSync-substring map already driving the gate so each test can
  // toggle the Artibot-repo signal independently.
  isArtibotRepo: vi.fn((cwd) => {
    if (!cwd) return false;
    for (const [key, val] of Object.entries(mockState.existsSyncResults)) {
      if (key === 'CLAUDE.md' && val) return true;
      if (key === 'artibot.config.json' && val) return true;
    }
    return false;
  }),
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
  // v4.7.2 (P1-1): getChangedFiles switched to execFileSync (shell-free).
  // Map argv-array form ['git', 'diff', '--name-status', '--diff-filter=ACMR', ...]
  // to the same matcher list by joining argv into a virtual command string.
  execFileSync: vi.fn((file, args /*, opts */) => {
    const cmd = [file, ...(Array.isArray(args) ? args : [])].join(' ');
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
  // v4.7.4: default to Artibot repo so existing tests still exercise the gate.
  // The new "skips silently when not in Artibot repo" test overrides this to {}.
  mockState.existsSyncResults = { 'artibot.config.json': true };
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
      // v4.7.4: isArtibotRepo gate signal — must pass for the gate to proceed.
      'CLAUDE.md': true,
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
      // v4.7.4: isArtibotRepo gate signal — must pass for the gate to proceed.
      'CLAUDE.md': true,
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
    const payload = mockState.writeStdoutCalls[0];
    // The payload may use 'reason' or 'message' depending on decision path.
    const text = payload.reason || payload.message || JSON.stringify(payload);
    // Core invariant: the rename's old path (old/foo.js) must NOT appear.
    expect(text).not.toContain('old/foo.js');
    // If approved, the file count should reflect 2 changed files (new/foo.js + regular.js).
    // If blocked (e.g., "Code without tests"), that's also valid — the rename parsing still worked.
    if (payload.decision === 'approve') {
      const receivedFiles = text.match(/(\d+)\s+changed file/);
      expect(receivedFiles?.[1]).toBe('2');
    }
  });
});

// ---------------------------------------------------------------------------
// v4.7.4 hotfix — isArtibotRepo guard (silent skip in non-Artibot repos)
// ---------------------------------------------------------------------------
describe('stop-review-gate — isArtibotRepo guard', () => {
  it('skips silently when not in Artibot repo (no plugins/artibot/CLAUDE.md, no artibot.config.json)', async () => {
    // Override default Artibot-repo mock with empty existsSync — every path
    // returns false → isArtibotRepo() returns false → main() returns silently.
    mockState.existsSyncResults = {};
    mockState.execSyncResponses = [
      ['git rev-parse --show-toplevel', '/some/other/repo'],
      // No diff mock — if main() proceeds past isArtibotRepo it will throw.
    ];
    mockState.readStdinResult = Promise.resolve(JSON.stringify({}));

    await import('../../scripts/hooks/stop-review-gate.js');

    expect(mockState.writeStdoutCalls).toHaveLength(0);
    const logs = stderrSpy.mock.calls.map(([m]) => m).join('');
    // Should not log review-gate messages — completely silent.
    expect(logs).not.toContain('Review gate');
    expect(logs).not.toContain('changed files');
  });

  it('proceeds when in Artibot repo (plugins/artibot/CLAUDE.md present)', async () => {
    mockState.existsSyncResults = { 'CLAUDE.md': true };
    mockState.execSyncResponses = [
      ['git rev-parse --show-toplevel', '/artibot/repo'],
      ['git diff --name-status', ''],
    ];
    mockState.readStdinResult = Promise.resolve(JSON.stringify({}));

    await import('../../scripts/hooks/stop-review-gate.js');

    // No-changes path emits an approve decision.
    expect(mockState.writeStdoutCalls).toHaveLength(1);
    expect(mockState.writeStdoutCalls[0].decision).toBe('approve');
  });
});
