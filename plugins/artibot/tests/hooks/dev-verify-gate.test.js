import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { buildDevVerifyOutput } from '../../lib/core/dev-verify-output.js';
import { verifyCompletedIdempotencyKey } from '../../lib/verification/verify-writer.js';

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

/**
 * 원장 포트 대역(OB-07). `mockState.repoRoot` 는 '/fake/repo' 라 실제 디스크의
 * `C:\fake\repo` (POSIX 라면 `/fake/repo`) 로 풀린다 — 훅이 이제 원장을 쓰므로
 * 대역이 없으면 이 스위트가 샌드박스 밖에 파일을 만든다. 그래서 append/read
 * 두 포트를 여기서 가로챈다. `vi.hoisted` 인 이유: `vi.mock` 팩토리는 변수
 * 선언 위로 끌어올려지므로 평범한 `const` 는 팩토리 안에서 TDZ 로 죽는다.
 */
const ledgerMock = vi.hoisted(() => ({
  /** @type {Array<{projectRoot: string, event: object}>} */
  appends: [],
  /** @type {Array<{projectRoot: string, filter: object}>} */
  reads: [],
  readThrows: false,
  /** @type {object[]} */
  events: [],
}));

vi.mock('../../lib/runtime/ledger.js', () => ({
  // `stdoutChunksAtAppend` 는 순서 계약의 관측점이다: 이 append 가 일어난
  // 순간 stdout 이 이미 쓰였는지를 그 자리에서 찍는다. 사후에 두 배열을
  // 비교하는 것으로는 순서를 알 수 없다.
  appendLedgerEvent: vi.fn((projectRoot, event) => {
    ledgerMock.appends.push({
      projectRoot, event, stdoutChunksAtAppend: mockState.stdoutChunks.length,
    });
    return {
      ok: true, path: '<mocked>', event: event.event, seq: ledgerMock.appends.length, bytes: 0,
    };
  }),
  readAllEvents: vi.fn((projectRoot, filter) => {
    ledgerMock.reads.push({ projectRoot, filter });
    if (ledgerMock.readThrows) throw new Error('ledger unreadable (injected)');
    return ledgerMock.events;
  }),
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

// ---------------------------------------------------------------------------
// 미측정 분모(unmeasured denominator) — 원장 배선 (OB-07)
//
// 게이트가 발화하면 `verify.completed` 4줄(레이어 3 + overall 1)을 전부
// `result: "unmeasured"` 로 남긴다. 이 스위트는 **주입된 포트**로만 잰다.
// 실제 프로세스로 재는 쪽(원장 파일 내용·stdout 바이트·멱등성)은
// `tests/hooks/dev-verify-gate-ledger.test.js` 에 있다 — 이 파일은
// `node:child_process` 를 execSync 만 있는 팩토리로 대역하므로 여기서는
// 자식 프로세스를 띄울 수 없다.
//
// 케이스 (c)"lib import 실패"는 여기서만 잴 수 있다. 훅은 `lib/` 를 자기
// 파일 기준 상대경로로 푸므로 샌드박스로는 그 모듈을 없앨 수 없고,
// `vi.doMock` 으로 던지는 모듈을 꽂는 것이 유일한 측정 수단이다.
// ---------------------------------------------------------------------------
describe('dev-verify-gate / 미측정 분모 원장 기록', () => {
  let denomRoot;
  /** 신선 케이스에서만 쓰는 실제 디렉터리. 빈 문자열이면 정리할 것이 없다. */
  let freshRepoRoot = '';

  /**
   * PINNED COPY of `dev-verify-gate.js#DEV_VERIFY_REASON` (모듈 비공개라
   * import 불가). 훅의 문자열이 바뀌면 이 단언이 깨지고 둘을 함께 고치게 된다.
   */
  const DEV_VERIFY_REASON =
    'DEV verify (CLAUDE.md DEV Protocol): report per-item evidence (file:line); '
    + "flag anything unproven as 'Pending verification'.";

  // 이 스위트에서 `resolveConfigPath` 는 대역에 없어 loadVerifyMode() 가
  // 기본값으로 떨어진다 → mode 'enforce'.
  const EXPECTED_STDOUT = JSON.stringify(
    buildDevVerifyOutput(DEV_VERIFY_REASON, { mode: 'enforce', hookEventName: 'Stop' }),
  );

  const SESSION = 'sessVGW00001';

  function fireFixture() {
    denomRoot = mkdtempSync(path.join(os.tmpdir(), 'artibot-dvg-denom-'));
    mockState.pluginRoot = denomRoot;
    mockState.stdoutChunks = [];
    mockState.execLog = [];
    mockState.dualDiff = { z: 'lib/a.js\0', plain: 'lib/a.js\n' };
    mockState.stdin = JSON.stringify({
      session_id: SESSION, hook_event_name: 'Stop', stop_hook_active: false,
    });
    // 마커만 있고 캐시가 없으면 게이트가 발화한다.
    const runtime = path.join(denomRoot, 'runtime');
    mkdirSync(runtime, { recursive: true });
    writeFileSync(path.join(runtime, 'last-main-agent-edit.timestamp'), 'x');
  }

  beforeEach(() => {
    ledgerMock.appends.length = 0;
    ledgerMock.reads.length = 0;
    ledgerMock.readThrows = false;
    ledgerMock.events = [];
    // Restored per case because the deterministic-source case below repoints it
    // at a real directory: '/fake/repo' has no vitest result file on any disk,
    // which is exactly why every OTHER case here stays `unmeasured`.
    mockState.repoRoot = '/fake/repo';
    fireFixture();
  });

  afterEach(() => {
    try { rmSync(denomRoot, { recursive: true, force: true }); } catch { /* ignore */ }
    if (freshRepoRoot) {
      try { rmSync(freshRepoRoot, { recursive: true, force: true }); } catch { /* ignore */ }
      freshRepoRoot = '';
    }
    vi.doUnmock('../../lib/verification/unified-verifier.js');
    vi.doUnmock('../../lib/verification/evidence-registry.js');
    vi.resetModules();
  });

  async function loadMain() {
    const mod = await import('../../scripts/hooks/dev-verify-gate.js');
    return mod.main;
  }

  it('레이어 3줄 + overall 1줄을 모두 unmeasured 로 append 한다', async () => {
    const main = await loadMain();
    await main();

    expect(ledgerMock.appends).toHaveLength(4);
    for (const { projectRoot, event } of ledgerMock.appends) {
      expect(projectRoot).toBe(mockState.repoRoot);
      expect(event.event).toBe('verify.completed');
      expect(event.session_id).toBe(SESSION);
      expect(event.source).toBe('gate');
      expect(event.data.result).toBe('unmeasured');
    }
    const layers = ledgerMock.appends
      .map(({ event }) => event.data.layer)
      .filter((l) => typeof l === 'string')
      .sort();
    expect(layers).toEqual(['behavioral', 'deterministic', 'operational']);
    // overall 줄은 layer 키 자체가 없어야 한다 — 읽기측
    // `lib/runtime/artifact-lifecycle-gates.js#tallyLayer` 가 그때만 별도
    // 버킷으로 세고, 레이어별 집계를 오염시키지 않는다.
    const overall = ledgerMock.appends.filter(({ event }) => !('layer' in event.data));
    expect(overall).toHaveLength(1);
    expect(mockState.stdoutChunks).toEqual([EXPECTED_STDOUT]);
  });

  /**
   * 순서 계약 핀 — stdout 이 원장보다 **먼저**다.
   *
   * 근거: `_dispatcher-utils.js#spawnHook` (:110) 은 8000ms 타임아웃에서
   * SIGTERM 을 보낸 뒤에도 **그때까지 모은 stdout 으로 resolve** 하고
   * (`finish('timeout')` :145 → `finish` :122-126), `_stop-dispatcher.js:74-76`
   * 은 `r.value.status` 를 보지 않고 `r.value.stdout` 만 파싱한다. 그래서
   * stdout 을 먼저 쓰면 원장이 아무리 늦어도 block 결정은 살아남는다. 이
   * 순서가 뒤집히면 그 보장이 사라지므로 여기서 못박는다.
   */
  it('원장 append 시점에 stdout 은 이미 쓰여 있다(순서 계약)', async () => {
    const main = await loadMain();
    await main();

    expect(ledgerMock.appends, '관측점이 비면 아래 단언은 공허하다').toHaveLength(4);
    for (const record of ledgerMock.appends) {
      expect(
        record.stdoutChunksAtAppend,
        'append 가 일어난 순간 stdout 이 이미 1건 쓰여 있어야 한다',
      ).toBe(1);
    }
  });

  it('세션과 verify.completed 로 좁혀서만 기존 키를 읽는다', async () => {
    const main = await loadMain();
    await main();
    expect(ledgerMock.reads).toHaveLength(1);
    expect(ledgerMock.reads[0]).toEqual({
      projectRoot: mockState.repoRoot,
      filter: { session_id: SESSION, event: 'verify.completed' },
    });
  });

  it('샌드박스 밖(/fake/repo)에 아무것도 만들지 않는다', async () => {
    const main = await loadMain();
    await main();
    // 대역이 빠지면 event-writer 가 실제로 여기에 디렉터리를 판다.
    expect(existsSync(path.resolve('/fake'))).toBe(false);
    expect(existsSync(path.resolve('/fake/repo'))).toBe(false);
  });

  it('stdin 에 session_id 가 없으면 원장을 건드리지 않는다', async () => {
    mockState.stdin = JSON.stringify({ hook_event_name: 'Stop', stop_hook_active: false });
    const main = await loadMain();
    await main();
    expect(ledgerMock.appends).toHaveLength(0);
    expect(ledgerMock.reads).toHaveLength(0);
    expect(mockState.stdoutChunks).toEqual([EXPECTED_STDOUT]);
  });

  it('이미 있는 키는 다시 append 하지 않는다(같은 초 재시도)', async () => {
    // 1차 발화로 실제 키를 얻고, 그 키들을 "이미 원장에 있는 줄"로 되먹인다.
    const main = await loadMain();
    await main();
    const first = ledgerMock.appends.map(({ event }) => event);
    expect(first).toHaveLength(4);
    ledgerMock.events = first.map((event) => ({
      event: 'verify.completed', idempotency_key: event.idempotency_key,
    }));
    // 키 생성 규칙 자체도 함께 못박는다.
    const verificationId = first[0].data.verification_id;
    expect(ledgerMock.events.map((e) => e.idempotency_key)).toContain(
      verifyCompletedIdempotencyKey(SESSION, verificationId),
    );

    ledgerMock.appends.length = 0;
    fireFixture();
    await main();
    // 같은 초에 다시 돌면 verification_id 가 같아 전부 deduped 다. 다른 초면
    // 새 id 라 4줄이 더 붙는다 — 그래서 둘 중 하나여야 하고, 0 이 아니라면
    // 반드시 4 여야 한다.
    expect([0, 4]).toContain(ledgerMock.appends.length);
    expect(mockState.stdoutChunks).toEqual([EXPECTED_STDOUT]);
  });

  it('existingKeys 읽기가 던지면 한 줄도 쓰지 않는다(중복보다 부재를 택한다)', async () => {
    ledgerMock.readThrows = true;
    const main = await loadMain();
    await main();
    expect(ledgerMock.reads).toHaveLength(1);
    expect(ledgerMock.appends).toHaveLength(0);
    expect(mockState.stdoutChunks).toEqual([EXPECTED_STDOUT]);
  });

  /**
   * 신선한 vitest 결과가 있으면 deterministic 만 판정이 된다(오너 결정 F1·R1).
   *
   * 이 스위트의 다른 케이스가 전부 `unmeasured` 인 이유가 여기서 드러난다:
   * `mockState.repoRoot` 가 '/fake/repo' 라 결과 파일이 어느 디스크에도 없다.
   * `node:fs` 는 대역하지 않으므로 훅은 진짜로 읽는다 — repoRoot 를 실재
   * 디렉터리로 돌리고 리포터 산출물을 심으면 그것이 곧 분자다.
   *
   * 마커 mtime 을 10초 과거로 당기는 이유: fireFixture 가 방금 쓴 마커와
   * `new Date()` 결과가 같은 밀리초에 걸리면 `>=` 판정이 파일시스템 시간
   * 해상도에 좌우된다. sleep 대신 utimesSync 로 확정한다.
   */
  it('repoRoot 밑의 신선한 vitest 결과는 deterministic 을 pass 로 만든다', async () => {
    freshRepoRoot = mkdtempSync(path.join(os.tmpdir(), 'artibot-dvg-fresh-'));
    mockState.repoRoot = freshRepoRoot;
    const resultDir = path.join(freshRepoRoot, 'plugins', 'artibot', 'runtime');
    mkdirSync(resultDir, { recursive: true });
    writeFileSync(path.join(resultDir, 'last-test-result.json'), JSON.stringify({
      timestamp: new Date().toISOString(),
      durationMs: 132138,
      totalTests: 17377,
      passed: 17365,
      failed: 0,
      skipped: 12,
      failedFiles: [],
    }));
    const marker = path.join(denomRoot, 'runtime', 'last-main-agent-edit.timestamp');
    const aged = new Date(Date.now() - 10_000);
    utimesSync(marker, aged, aged);

    const main = await loadMain();
    await main();

    expect(ledgerMock.appends).toHaveLength(4);
    const byLayer = new Map(
      ledgerMock.appends.map(({ event }) => [event.data.layer ?? '<overall>', event.data]),
    );
    expect(byLayer.get('deterministic').result).toBe('pass');
    expect(byLayer.get('<overall>').result, 'deterministic 이 유일한 required 층이다').toBe('pass');
    expect(byLayer.get('behavioral').result, '러너가 없다').toBe('unmeasured');
    expect(byLayer.get('operational').result, '판독값이 없다').toBe('unmeasured');
    // 리포 상대경로여야 한다 — 절대경로를 남기면 다른 기계가 읽을 수 없다.
    expect(byLayer.get('deterministic').evidence[0].file)
      .toBe('plugins/artibot/runtime/last-test-result.json');
    expect(byLayer.get('deterministic').evidence[0].note).toContain('vitest total=17377');
    expect(mockState.stdoutChunks, 'stdout 은 판정과 무관하게 동일하다').toEqual([EXPECTED_STDOUT]);
  });

  it('결과가 마지막 main-agent 편집보다 낡았으면 4줄 전부 unmeasured 로 남는다', async () => {
    freshRepoRoot = mkdtempSync(path.join(os.tmpdir(), 'artibot-dvg-stale-'));
    mockState.repoRoot = freshRepoRoot;
    const resultDir = path.join(freshRepoRoot, 'plugins', 'artibot', 'runtime');
    mkdirSync(resultDir, { recursive: true });
    writeFileSync(path.join(resultDir, 'last-test-result.json'), JSON.stringify({
      timestamp: new Date(Date.now() - 600_000).toISOString(),
      durationMs: 1, totalTests: 1, passed: 1, failed: 0, skipped: 0, failedFiles: [],
    }));

    const main = await loadMain();
    await main();

    expect(ledgerMock.appends).toHaveLength(4);
    for (const { event } of ledgerMock.appends) {
      expect(event.data.result, '낡은 초록을 PASS 로 쓰지 않는다(F1)').toBe('unmeasured');
      expect(event.data.evidence, '미측정 줄은 증거를 남기지 않는다').toEqual([]);
    }
    expect(mockState.stdoutChunks).toEqual([EXPECTED_STDOUT]);
  });

  it('(케이스 c) 검증 lib 가 로드 중 던져도 stdout 은 바이트 동일하다', async () => {
    vi.resetModules();
    vi.doMock('../../lib/verification/unified-verifier.js', () => {
      throw new Error('injected import-time failure');
    });
    const main = await loadMain();
    await main();
    expect(ledgerMock.appends).toHaveLength(0);
    expect(mockState.stdoutChunks).toEqual([EXPECTED_STDOUT]);
    expect(Buffer.from(mockState.stdoutChunks[0], 'utf-8')
      .equals(Buffer.from(EXPECTED_STDOUT, 'utf-8'))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 증거 레지스트리 포트 (sh15). 증거를 가진 줄은 신선한 결과가 있을 때만
  // 생기므로(미측정 줄은 `evidence: []`) 세 케이스 모두 결과 파일을 심는다.
  // 레지스트리 모듈은 `vi.doMock` 으로 바꿔 끼운다 — 로드 실패는 케이스 c 와
  // 같은 이유로 여기서만 잴 수 있다.
  // -------------------------------------------------------------------------

  /** repoRoot 를 실재 디렉터리로 돌리고 신선한 리포터 산출물을 심는다. */
  function plantFreshResult() {
    freshRepoRoot = mkdtempSync(path.join(os.tmpdir(), 'artibot-dvg-registry-'));
    mockState.repoRoot = freshRepoRoot;
    const resultDir = path.join(freshRepoRoot, 'plugins', 'artibot', 'runtime');
    mkdirSync(resultDir, { recursive: true });
    writeFileSync(path.join(resultDir, 'last-test-result.json'), JSON.stringify({
      timestamp: new Date().toISOString(),
      durationMs: 1, totalTests: 5, passed: 5, failed: 0, skipped: 0, failedFiles: [],
    }));
    const marker = path.join(denomRoot, 'runtime', 'last-main-agent-edit.timestamp');
    const aged = new Date(Date.now() - 10_000);
    utimesSync(marker, aged, aged);
  }

  it('레지스트리 포트는 원장과 같은 repoRoot 에, 원장 줄 키를 source 로 묶인다', async () => {
    plantFreshResult();
    const calls = [];
    vi.doMock('../../lib/verification/evidence-registry.js', () => ({
      registerEvidence: (entries, opts) => {
        calls.push({ entries, opts });
        return { ids: [], appended: 0, reused: 0 };
      },
    }));
    const main = await loadMain();
    await main();

    expect(ledgerMock.appends).toHaveLength(4);
    const withEvidence = ledgerMock.appends.filter(({ event }) => event.data.evidence.length > 0);
    expect(withEvidence, 'overall + deterministic 두 줄만 증거를 가진다').toHaveLength(2);
    expect(calls.map((c) => c.opts.source)).toEqual(
      withEvidence.map(({ event }) => event.idempotency_key),
    );
    for (const { entries, opts } of calls) {
      expect(opts.projectRoot, '원장 append 와 같은 루트').toBe(mockState.repoRoot);
      expect(entries[0].file).toBe('plugins/artibot/runtime/last-test-result.json');
    }
    expect(mockState.stdoutChunks).toEqual([EXPECTED_STDOUT]);
  });

  it('레지스트리 모듈이 로드 중 던져도 원장 4줄과 stdout 은 그대로다', async () => {
    plantFreshResult();
    vi.doMock('../../lib/verification/evidence-registry.js', () => {
      throw new Error('injected registry import failure');
    });
    const main = await loadMain();
    await main();

    // 레지스트리는 부가 기록이다 — 그 로드 실패가 분모를 앗아가면 안 된다.
    expect(ledgerMock.appends).toHaveLength(4);
    const deterministic = ledgerMock.appends.find(({ event }) => event.data.layer === 'deterministic');
    expect(deterministic.event.data.result).toBe('pass');
    expect(mockState.stdoutChunks).toEqual([EXPECTED_STDOUT]);
  });

  it('registerEvidence 가 던져도 원장 4줄과 stdout 은 그대로다', async () => {
    plantFreshResult();
    let called = 0;
    vi.doMock('../../lib/verification/evidence-registry.js', () => ({
      registerEvidence: () => {
        called += 1;
        throw new Error('injected registry failure');
      },
    }));
    const main = await loadMain();
    await main();

    expect(called, '던지는 포트가 실제로 불렸어야 이 케이스가 뭔가를 잰다').toBeGreaterThan(0);
    expect(ledgerMock.appends).toHaveLength(4);
    expect(mockState.stdoutChunks).toEqual([EXPECTED_STDOUT]);
  });
});
