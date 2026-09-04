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

/**
 * Import the hook and run its entry point. The module carries a direct-run
 * guard, so importing it no longer executes `main()` — the call has to be
 * explicit here, exactly as the spawned production process makes it.
 *
 * @returns {Promise<void>}
 */
async function runHook() {
  const mod = await import('../../scripts/hooks/stop-review-gate.js');
  await mod.main();
}

// ---------------------------------------------------------------------------
// B-2 stop_hook_active recursion guard
// ---------------------------------------------------------------------------
describe('stop-review-gate — stop_hook_active recursion guard', () => {
  it('returns immediately without writing stdout when stop_hook_active=true', async () => {
    mockState.readStdinResult = Promise.resolve(JSON.stringify({ stop_hook_active: true }));
    // No execSync responses defined — if main() proceeds it will throw.
    await runHook();
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
    await runHook();
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
      // Source builds:
      //   `git diff --name-status -z --diff-filter=ACMR HEAD~1 HEAD ...`
      // 후속 19 (#11): -z 라 status 와 path 가 별개 NUL 필드다 ("M" NUL path NUL).
      // Deletion entries (D) would be filtered out by git itself; we simulate
      // that by NOT emitting any "D" rows.  Bracket-mismatch / pattern checks
      // pass on the trivial body returned by readFileSync.
      ['diff --name-status', 'M\0plugins/artibot/lib/foo.js\0A\0plugins/artibot/lib/bar.js\0'],
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

    await runHook();
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
      // 후속 19 (#11) -z 형태:
      //   rename → "R100" NUL "old" NUL "new" NUL  (경로 2개, 새 이름을 취한다)
      //   modify → "M" NUL "path" NUL
      ['diff --name-status', () => {
        return 'R100\0old/foo.js\0new/foo.js\0M\0plugins/artibot/lib/regular.js\0';
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
    await runHook();
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

    await runHook();

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

    await runHook();

    // No-changes path emits an approve decision.
    expect(mockState.writeStdoutCalls).toHaveLength(1);
    expect(mockState.writeStdoutCalls[0].decision).toBe('approve');
  });
});

// ---------------------------------------------------------------------------
// v4.8.0 R2 — suffix-test variant recognition
// Source `foo.js` is considered covered if any test stem starts with `foo-`
// (e.g. foo-security.test.js, foo-edge-cases.test.js). Prevents false-positive
// "Code without tests" warnings for source files split into domain-narrowed
// test files. Regression for git-backend.js / git-backend-security.test.js.
// ---------------------------------------------------------------------------
describe('stop-review-gate — checkMissingTests suffix variant', () => {
  it('does not flag code as missing tests when only a hyphen-suffixed test exists', async () => {
    // git-backend.js has only git-backend-security.test.js — must NOT be flagged.
    mockState.readStdinResult = Promise.resolve(JSON.stringify({}));
    mockState.execSyncResponses = [
      ['rev-parse --show-toplevel', '/repo'],
      ['diff --name-status', 'M\0plugins/artibot/lib/swarm/git-backend.js\0'],
    ];
    mockState.existsSyncResults = {
      'plugins/artibot/lib/swarm/git-backend.js': true,
      // tests/ directory must exist so collectTestBasenames is invoked.
      'plugins/artibot/tests': true,
      'CLAUDE.md': true,
      'artibot.config.json': false,
    };
    mockState.readFileSyncImpl = () => 'export const x = 1;\n';

    // Override readdirSync ONLY for this test to emit a single suffixed test file.
    const fs = await import('node:fs');
    fs.readdirSync.mockImplementation((dir) => {
      if (String(dir).includes('plugins/artibot/tests')
          || String(dir).includes('plugins\\artibot\\tests')) {
        return [{
          name: 'git-backend-security.test.js',
          isFile: () => true,
          isDirectory: () => false,
        }];
      }
      return [];
    });

    await runHook();

    expect(mockState.writeStdoutCalls).toHaveLength(1);
    const payload = mockState.writeStdoutCalls[0];
    const reason = String(payload.reason ?? '');
    // The contract under test: hyphen-suffixed tests count toward the
    // missing-test gate. The only invariant we assert is that the
    // "Code without tests" warning does NOT fire for this case.
    //
    // The previous version also asserted `reason` could not contain the
    // string 'git-backend.js' at all. That was over-specified: other
    // detectors (e.g. Bracket mismatch syntax check) are free to flag the
    // same file for unrelated reasons, and on CI Linux one such detector
    // did, producing "Bracket mismatch: git-backend.js: syntax error" and
    // failing the assertion even though the missing-test gate worked
    // correctly. Windows local did not exhibit the same detector path,
    // hiding the over-specification until CI surfaced it.
    expect(reason).not.toContain('Code without tests');
  });

});

// ---------------------------------------------------------------------------
// getChangedFiles — --name-status -z 파서 (후속 19 #11, stop-review-gate.js:79-80)
// ---------------------------------------------------------------------------
//
// 이 자리는 12자리 중 **유일한 파서 재작성**이다. `--name-status` 는 `-z` 를
// 붙이면 단순히 구분자만 바뀌는 게 아니라 **필드 구조가 달라진다**:
//
//   개행형  "M\tpath"              · rename "R100\told\tnew"
//   -z 형   "M" NUL "path" NUL      · rename "R100" NUL "old" NUL "new" NUL
//
// 즉 status 와 path 가 **별개 NUL 필드**이고, R/C 만 경로가 2개다. 탭 분해로는
// 읽을 수 없으므로 상태별 필드 수를 세는 파서가 필요하다.
//
// 실제 피해: 여기서 나온 경로는 existsSync/readFileSync 로 곧장 넘어간다.
// C-quote 된 경로는 존재하지 않으므로 **한글 경로 파일은 리뷰 대상에서 조용히
// 빠진다** — 게이트가 통과시키는 것이 아니라 아예 보지 못한다.
describe('stop-review-gate — --name-status -z 파서 (후속 19 #11)', () => {
  const KO = 'plugins/artibot/lib/한글폴더/설계문서.js';
  const SPACE = 'plugins/artibot/lib/with space/파일 이름.js';
  const KO_CQ =
    '"plugins/artibot/lib/\\355\\225\\234\\352\\270\\200\\355\\217\\264\\353\\215\\224/'
    + '\\354\\204\\244\\352\\263\\204\\353\\254\\270\\354\\204\\234.js"';

  // -z 유무로 형태를 가른다 — 옛 코드가 -z 를 넘기지 않는 사실 자체가 RED.
  const dual = (zForm, plainForm) => (cmd) => (cmd.includes(' -z ') ? zForm : plainForm);

  function readPaths() {
    const seen = [];
    mockState.readFileSyncImpl = (p) => {
      seen.push(String(p));
      return 'export const x = 1;\n';
    };
    return seen;
  }

  it('두 diff 변형 모두 -z 를 넘긴다', async () => {
    mockState.readStdinResult = Promise.resolve(JSON.stringify({}));
    mockState.execSyncResponses = [
      ['rev-parse --show-toplevel', '/repo'],
      ['diff --name-status', dual('M\0plugins/artibot/lib/a.js\0', 'M\tplugins/artibot/lib/a.js\n')],
    ];
    mockState.existsSyncResults = {
      'a.js': true,
      'tests': false,
      'CLAUDE.md': true,
      'artibot.config.json': false,
    };
    readPaths();

    await runHook();

    const diffCmds = mockState.execLog.filter((c) => c.includes('diff --name-status'));
    // 자기검증: 호출이 없으면 아래 단언은 공허하다.
    expect(diffCmds.length).toBeGreaterThan(0);
    expect(diffCmds.every((c) => c.includes(' -z '))).toBe(true);
    // -z 를 넣어도 B-1 불변식(ACMR)은 유지된다.
    expect(diffCmds.every((c) => c.includes('--diff-filter=ACMR'))).toBe(true);
  });

  it('한글·공백 경로를 실제 경로로 읽는다', async () => {
    mockState.readStdinResult = Promise.resolve(JSON.stringify({}));
    mockState.execSyncResponses = [
      ['rev-parse --show-toplevel', '/repo'],
      ['diff --name-status', dual(
        `M\0${KO}\0M\0${SPACE}\0`,
        `M\t${KO_CQ}\nM\t"plugins/artibot/lib/with space/..."\n`,
      )],
    ];
    mockState.existsSyncResults = {
      '한글폴더': true,
      'with space': true,
      'plugins/artibot/tests': false,
      'CLAUDE.md': true,
      'artibot.config.json': false,
    };
    const seen = readPaths();

    await runHook();

    const joined = seen.join('|');
    expect(joined).toContain('설계문서.js');
    expect(joined).toContain('파일 이름.js');
    // C-quote 잔재가 파일 경로로 새지 않는다.
    expect(joined).not.toMatch(/\\[0-7]{3}/);
  });

  it('rename 은 3필드 — 새 경로만 취한다', async () => {
    mockState.readStdinResult = Promise.resolve(JSON.stringify({}));
    mockState.execSyncResponses = [
      ['rev-parse --show-toplevel', '/repo'],
      ['diff --name-status', dual(
        'R100\0plugins/artibot/lib/old.js\0plugins/artibot/lib/new.js\0'
        + 'M\0plugins/artibot/lib/regular.js\0',
        'R100\tplugins/artibot/lib/old.js\tplugins/artibot/lib/new.js\n'
        + 'M\tplugins/artibot/lib/regular.js\n',
      )],
    ];
    mockState.existsSyncResults = {
      'old.js': false,
      'new.js': true,
      'regular.js': true,
      'tests': false,
      'CLAUDE.md': true,
      'artibot.config.json': false,
    };
    const seen = readPaths();

    await runHook();

    const joined = seen.join('|');
    expect(joined).toContain('new.js');
    expect(joined).toContain('regular.js');
    // 옛 경로도, 상태 토큰도 파일명으로 새지 않는다.
    expect(joined).not.toContain('old.js');
    expect(seen.every((p) => !/(^|[\\/])R100$/.test(p))).toBe(true);
  });

  it('상태 토큰을 파일 경로로 세지 않는다', async () => {
    mockState.readStdinResult = Promise.resolve(JSON.stringify({}));
    mockState.execSyncResponses = [
      ['rev-parse --show-toplevel', '/repo'],
      ['diff --name-status', dual(
        'M\0plugins/artibot/lib/a.js\0A\0plugins/artibot/lib/b.js\0',
        'M\tplugins/artibot/lib/a.js\nA\tplugins/artibot/lib/b.js\n',
      )],
    ];
    mockState.existsSyncResults = {
      'a.js': true,
      'b.js': true,
      'tests': false,
      'CLAUDE.md': true,
      'artibot.config.json': false,
    };
    const seen = readPaths();

    await runHook();

    expect(seen).toHaveLength(2);
    for (const p of seen) expect(p).not.toMatch(/[\\/][MA]$/);
  });

  it('꼬리 NUL 을 빈 파일명으로 세지 않는다', async () => {
    mockState.readStdinResult = Promise.resolve(JSON.stringify({}));
    mockState.execSyncResponses = [
      ['rev-parse --show-toplevel', '/repo'],
      ['diff --name-status', dual('M\0plugins/artibot/lib/a.js\0', 'M\tplugins/artibot/lib/a.js\n')],
    ];
    mockState.existsSyncResults = {
      'a.js': true,
      'tests': false,
      'CLAUDE.md': true,
      'artibot.config.json': false,
    };
    const seen = readPaths();

    await runHook();

    expect(seen).toHaveLength(1);
  });
});
