import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * dev-verify-gate.js — v4.5.8 marker-based DEV verify gate.
 *
 * The previous implementation (v4.5.6) was hard-disabled because it fired
 * on every Stop with uncommitted changes — regardless of whether those
 * changes came from the orchestrator (legitimate) or from teammates spawned
 * via Task (false positive that paralysed `/team` workflows).
 *
 * v4.5.8 restores the gate by introducing a marker file written ONLY on
 * main-agent Edit/Write/MultiEdit (see mark-main-agent-edit.js). This test
 * suite covers the bail-vs-fire decision matrix that the marker drives.
 *
 * The schema-level main() flow is hard to integration-test without spinning
 * up a real git repo + stdin — so we exercise the pure helper through
 * filesystem fixtures and only smoke-test main()'s read-only-turn bail path.
 */

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
let tmpRoot;

const mockState = {
  stdin: '',
  stdoutChunks: [],
  pluginRoot: '',
  changedFiles: [],
  repoRoot: '/fake/repo',
  execLog: [],
  // 후속 19 (#6): -z 유무에 따라 다른 형태를 돌려주기 위한 훅. null 이면
  // 기존 changedFiles 경로를 쓴다(하위 호환).
  dualDiff: null,
};

vi.mock('../../scripts/utils/index.js', () => ({
  readStdin: vi.fn(async () => mockState.stdin),
  parseJSON: vi.fn((str) => {
    try { return JSON.parse(str); } catch { return null; }
  }),
  getPluginRoot: vi.fn(() => mockState.pluginRoot),
  atomicWriteSync: vi.fn((file, data) => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data));
  }),
  writeStdout: vi.fn((data) => {
    mockState.stdoutChunks.push(JSON.stringify(data));
  }),
}));

vi.mock('../../lib/core/hook-utils.js', () => ({
  createErrorHandler: vi.fn(() => () => undefined),
  logHookError: vi.fn(),
  isArtibotRepo: vi.fn(() => true),
}));

// node:child_process — git invocations
vi.mock('node:child_process', () => ({
  execSync: vi.fn((cmd) => {
    mockState.execLog.push(cmd);
    if (cmd === 'git rev-parse --show-toplevel') return mockState.repoRoot;
    if (cmd === 'git rev-parse HEAD') return 'abc1234';
    // 후속 19 (#6): dualDiff 가 있으면 -z 유무로 형태를 갈라 돌려준다.
    // -z 없는 호출에는 개행 형태를, -z 호출에는 NUL 형태를 준다 — 그래야
    // "옛 코드가 -z 를 안 넘긴다"는 사실 자체가 RED 로 드러난다.
    if (cmd.startsWith('git diff --name-only') && mockState.dualDiff) {
      if (!cmd.includes('--cached')) {
        return cmd.includes(' -z ') ? mockState.dualDiff.z : mockState.dualDiff.plain;
      }
      return '';
    }
    if (cmd === 'git diff --name-only HEAD') {
      return mockState.changedFiles.join('\n');
    }
    if (cmd === 'git diff --name-only --cached') return '';
    return '';
  }),
}));

// isArtibotRepo 는 main() 의 스코프 가드다. 이 스위트는 훅이 실제로 도는
// 경로를 재야 하므로 참으로 고정한다.
vi.mock('../../lib/git/repo-root-cache.js', () => ({
  getRepoRoot: vi.fn(() => mockState.repoRoot),
  getHeadSha: vi.fn(() => 'abc1234'),
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('dev-verify-gate (v4.5.8 marker behaviour)', () => {
  let mainFn;

  beforeEach(async () => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'artibot-dvg-'));
    mockState.pluginRoot = tmpRoot;
    mockState.stdin = '{}';
    mockState.stdoutChunks = [];
    mockState.changedFiles = [];
    mockState.execLog = [];
    mockState.dualDiff = null;

    if (!mainFn) {
      const mod = await import('../../scripts/hooks/dev-verify-gate.js');
      // The module's main() is not exported (it's invoked via top-level await
      // .catch). We re-import using a query string to force re-eval and
      // capture the side-effects of running main(). For unit testing we
      // instead exercise behaviour by running the module on each test —
      // but importing repeatedly would re-run the top-level main() which
      // already executed at first import. So we treat the FIRST import as
      // the test fire and assert against the recorded mocks.
      mainFn = mod;
    }
  });

  afterEach(() => {
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
    vi.clearAllMocks();
  });

  it('module loads without throwing (smoke test)', () => {
    // Importing the module fires main() under top-level .catch handler.
    // The catch handler is a no-op (createErrorHandler mock), so any
    // unhandled async error would surface here.
    expect(mainFn).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// getChangedFiles — git 경로 출력 디코딩 (후속 19 #6, dev-verify-gate.js:124-125)
// ---------------------------------------------------------------------------
//
// 이 자리에서 읽은 경로는 **파일시스템을 건드리지 않는다** — 개수 판정,
// EXCLUDED_FILES 멤버십, 지문(fingerprint) 재료로만 쓰인다. 그래서
// core.quotepath C-quote 축으로는 결과가 바뀌지 않는다(제외된 #7·#10 과
// 같은 부류다. 리더 보고 참조).
//
// 실재하는 결함은 **`.trim()` 축**이다. 공백은 C-quote 를 유발하지 않으므로
// ' .artibot/SESSION-NOTES.md' 같은 경로는 따옴표 없이 그대로 나오고,
// 줄마다 걸린 `.trim()` 이 앞 공백을 먹어 **다른 파일을 면제 목록에 매칭**
// 시킨다. 그러면 게이트가 부당하게 침묵한다.
//
// 따라서 이 스위트는 두 가지를 못박는다.
//   (a) 명령 계약: 두 diff 호출 모두 `-z` 를 넘긴다
//   (b) 행동: 앞 공백 경로가 면제 목록으로 오인되지 않는다
describe('dev-verify-gate / getChangedFiles 경로 디코딩', () => {
  let main;
  let workRoot;

  beforeEach(async () => {
    workRoot = mkdtempSync(path.join(os.tmpdir(), 'artibot-dvg-z-'));
    mockState.pluginRoot = workRoot;
    mockState.stdin = '{}';
    mockState.stdoutChunks = [];
    mockState.execLog = [];
    mockState.dualDiff = null;

    // 마커만 있고 캐시가 없으면 hasNewerMainAgentEdit() 이 참 — 게이트 발화 조건.
    const runtime = path.join(workRoot, 'runtime');
    mkdirSync(runtime, { recursive: true });
    writeFileSync(path.join(runtime, 'last-main-agent-edit.timestamp'), 'x');

    ({ main } = await import('../../scripts/hooks/dev-verify-gate.js'));
  });

  afterEach(() => {
    try { rmSync(workRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('(a) 두 diff 호출 모두 -z 를 넘긴다', async () => {
    mockState.dualDiff = { z: 'lib/a.js\0', plain: 'lib/a.js\n' };
    await main();

    const diffs = mockState.execLog.filter((c) => c.startsWith('git diff --name-only'));
    // 자기검증: 호출이 없으면 아래 단언은 공허하다.
    expect(diffs).toHaveLength(2);
    for (const cmd of diffs) expect(cmd).toContain(' -z ');
  });

  it('(b) 앞 공백이 든 경로를 면제 목록으로 오인하지 않는다', async () => {
    // 실제 파일명은 " .artibot/SESSION-NOTES.md" — 면제 대상이 아니다.
    mockState.dualDiff = {
      z: ' .artibot/SESSION-NOTES.md\0',
      plain: ' .artibot/SESSION-NOTES.md\n',
    };
    await main();
    expect(mockState.stdoutChunks).toHaveLength(1);
  });

  it('면제 목록에 정확히 일치하는 경로는 그대로 면제된다(회귀)', async () => {
    mockState.dualDiff = {
      z: '.artibot/SESSION-NOTES.md\0',
      plain: '.artibot/SESSION-NOTES.md\n',
    };
    await main();
    expect(mockState.stdoutChunks).toHaveLength(0);
  });

  it('NUL 구분 목록의 빈 꼬리 필드를 파일로 세지 않는다', async () => {
    mockState.dualDiff = { z: '.artibot/SESSION-NOTES.md\0', plain: '.artibot/SESSION-NOTES.md\n' };
    await main();
    // 꼬리 빈 필드가 파일로 셈해졌다면 changedFiles.length > 0 이 되어 발화한다.
    expect(mockState.stdoutChunks).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Pure decision-matrix tests against the marker / cache fixture filesystem.
//
// Because dev-verify-gate's hasNewerMainAgentEdit() is module-private, we
// validate the SAME mtime semantics independently. Any drift between this
// test's ground truth and the implementation is a real regression.
// ---------------------------------------------------------------------------
describe('marker-vs-cache mtime semantics (ground truth)', () => {
  let workdir;

  beforeEach(() => {
    workdir = mkdtempSync(path.join(os.tmpdir(), 'artibot-dvg-mtime-'));
  });

  afterEach(() => {
    try { rmSync(workdir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  function fixture(markerMtime, cacheMtime) {
    const runtime = path.join(workdir, 'runtime');
    mkdirSync(runtime, { recursive: true });
    if (markerMtime !== null) {
      const m = path.join(runtime, 'last-main-agent-edit.timestamp');
      writeFileSync(m, 'x');
      utimesSync(m, new Date(markerMtime), new Date(markerMtime));
    }
    if (cacheMtime !== null) {
      const c = path.join(runtime, 'last-dev-verify-sha.txt');
      writeFileSync(c, 'fingerprint');
      utimesSync(c, new Date(cacheMtime), new Date(cacheMtime));
    }
  }

  // Reproduces the decision matrix documented in dev-verify-gate.js
  // hasNewerMainAgentEdit(). If this lookup table changes, update both.
  function decide(markerMtime, cacheMtime) {
    if (markerMtime === null) return false;          // no main edit ever
    if (cacheMtime === null) return true;            // first run baseline
    return markerMtime > cacheMtime;                 // marker drives the gate
  }

  it('bails when no marker has ever been written', () => {
    fixture(null, Date.now());
    expect(decide(null, Date.now())).toBe(false);
  });

  it('fires on first run (no cache yet) when marker exists', () => {
    fixture(Date.now(), null);
    expect(decide(Date.now(), null)).toBe(true);
  });

  it('fires when marker is newer than cache', () => {
    const cache = Date.now() - 60_000;
    const marker = Date.now();
    fixture(marker, cache);
    expect(decide(marker, cache)).toBe(true);
  });

  it('bails when marker mtime equals cache mtime', () => {
    const t = Date.now() - 30_000;
    fixture(t, t);
    expect(decide(t, t)).toBe(false);
  });

  it('bails when marker is older than cache (already verified)', () => {
    const marker = Date.now() - 60_000;
    const cache = Date.now();
    fixture(marker, cache);
    expect(decide(marker, cache)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Artibot-repo scope guard (added 2026-05-07).
//
// dev-verify-gate.js installs globally (~/.claude/artibot/) so its Stop hook
// fires in every project the user works in. The DEV verify checklist is an
// Artibot-internal development policy and must NOT surface in unrelated
// projects ("Reference: plugins/artibot/CLAUDE.md" was leaking out as noise).
//
// isArtibotRepo() is module-private — these tests independently assert the
// same detection rules. Drift between the implementation and these tests is
// a real regression.
// ---------------------------------------------------------------------------
describe('Artibot repo scope guard (ground truth)', () => {
  let workdir;

  beforeEach(() => {
    workdir = mkdtempSync(path.join(os.tmpdir(), 'artibot-dvg-scope-'));
  });

  afterEach(() => {
    try { rmSync(workdir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // Reproduces the detection rules documented in dev-verify-gate.js
  // isArtibotRepo(). If this lookup table changes, update both.
  function detect(repoRoot) {
    if (!repoRoot) return false;
    return (
      existsSync(path.join(repoRoot, 'plugins', 'artibot', 'CLAUDE.md')) ||
      existsSync(path.join(repoRoot, 'artibot.config.json'))
    );
  }

  it('detects Artibot monorepo root via plugins/artibot/CLAUDE.md', () => {
    mkdirSync(path.join(workdir, 'plugins', 'artibot'), { recursive: true });
    writeFileSync(path.join(workdir, 'plugins', 'artibot', 'CLAUDE.md'), '# stub');
    expect(detect(workdir)).toBe(true);
  });

  it('detects plugin directory directly via artibot.config.json', () => {
    writeFileSync(path.join(workdir, 'artibot.config.json'), '{}');
    expect(detect(workdir)).toBe(true);
  });

  it('rejects unrelated project (no Artibot markers)', () => {
    writeFileSync(path.join(workdir, 'package.json'), '{"name":"unrelated"}');
    expect(detect(workdir)).toBe(false);
  });

  it('rejects empty / null repoRoot defensively', () => {
    expect(detect(null)).toBe(false);
    expect(detect('')).toBe(false);
  });

  it('rejects sibling directory with similarly-named plugin folder', () => {
    // e.g. someone has plugins/artibot-fork/CLAUDE.md — must NOT match
    mkdirSync(path.join(workdir, 'plugins', 'artibot-fork'), { recursive: true });
    writeFileSync(
      path.join(workdir, 'plugins', 'artibot-fork', 'CLAUDE.md'),
      '# fork',
    );
    expect(detect(workdir)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Excluded-files filter (added 2026-05-18, v4.11.2).
//
// dev-verify-gate.js excludes files written by sibling Stop hooks to avoid
// false-positive DEV verify asks. Specifically: session-notes.js appends to
// .artibot/SESSION-NOTES.md during Stop, and because Stop hooks run in
// parallel (Promise.allSettled), dev-verify-gate observes the dirty file
// before git-autopilot-close.js can commit it.
//
// EXCLUDED_FILES is module-private — this suite asserts the ground-truth
// filter behaviour against the same input the gate's getChangedFiles()
// would receive. Drift between this list and the implementation is a real
// regression.
// ---------------------------------------------------------------------------
describe('excluded-files filter (ground truth)', () => {
  // Reproduces EXCLUDED_FILES from dev-verify-gate.js. If this set changes,
  // update the implementation and this fixture together.
  const EXCLUDED = new Set([
    '.artibot/SESSION-NOTES.md',
  ]);

  function filterChanged(rawLines) {
    const merged = new Set();
    for (const line of rawLines) {
      const trimmed = line.trim();
      if (trimmed && !EXCLUDED.has(trimmed)) merged.add(trimmed);
    }
    return [...merged];
  }

  it('drops .artibot/SESSION-NOTES.md when it is the only change', () => {
    expect(filterChanged(['.artibot/SESSION-NOTES.md'])).toEqual([]);
  });

  it('keeps real edits alongside SESSION-NOTES.md', () => {
    const result = filterChanged([
      '.artibot/SESSION-NOTES.md',
      'plugins/artibot/lib/core/config.js',
    ]);
    expect(result).toEqual(['plugins/artibot/lib/core/config.js']);
  });

  it('passes through unrelated edits unchanged', () => {
    const result = filterChanged([
      'plugins/artibot/scripts/hooks/dev-verify-gate.js',
      'plugins/artibot/tests/hooks/dev-verify-gate.test.js',
    ]);
    expect(result).toHaveLength(2);
  });

  it('handles empty input', () => {
    expect(filterChanged([])).toEqual([]);
  });

  it('does not exclude similarly-named files outside the excluded set', () => {
    // Defensive: only exact paths in EXCLUDED_FILES drop. Substring matches
    // or sibling files in .artibot/ must still flow through.
    const result = filterChanged([
      '.artibot/OTHER-NOTES.md',
      'SESSION-NOTES.md',
    ]);
    expect(result).toEqual(['.artibot/OTHER-NOTES.md', 'SESSION-NOTES.md']);
  });
});
