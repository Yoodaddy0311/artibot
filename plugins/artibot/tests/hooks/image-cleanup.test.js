import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * image-cleanup.js — SessionStart hook that sweeps Claude Code auto-saved
 * pasted images (`image.png`, `image copy.png`, `image copy N.png`) from the
 * current working directory's root when they are small, recent, and untracked.
 */

// ---------------------------------------------------------------------------
// Shared mock state
// ---------------------------------------------------------------------------
const mockState = {
  readdirResult: [],
  statMap: {},           // name → { size, mtimeMs, isFile: true } or null (missing)
  execSyncImpl: () => '',
  existsSyncResults: {},
  readFileSyncImpl: () => { throw new Error('ENOENT'); },
  unlinkSpy: null,
  unlinkFailures: new Set(),
  stderrChunks: [],
  env: {},
};

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
vi.mock('../../lib/core/hook-utils.js', () => ({
  logHookError: vi.fn(),
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual('node:fs');
  return {
    ...actual,
    readdirSync: vi.fn(() => mockState.readdirResult),
    statSync: vi.fn((p) => {
      const name = String(p).split(/[\\/]/).pop();
      const meta = mockState.statMap[name];
      if (!meta) throw new Error('ENOENT');
      return { size: meta.size, mtimeMs: meta.mtimeMs, isFile: () => meta.isFile !== false };
    }),
    unlinkSync: vi.fn((p) => {
      const name = String(p).split(/[\\/]/).pop();
      if (mockState.unlinkFailures.has(name)) {
        const e = new Error('EBUSY');
        e.code = 'EBUSY';
        throw e;
      }
      // Success: record via spy helper on mockState
      mockState.unlinkSpy?.(name);
    }),
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
  execSync: vi.fn((...args) => mockState.execSyncImpl(...args)),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function resetState() {
  mockState.readdirResult = [];
  mockState.statMap = {};
  mockState.execSyncImpl = () => '';
  mockState.existsSyncResults = {};
  mockState.readFileSyncImpl = () => { throw new Error('ENOENT'); };
  mockState.unlinkFailures = new Set();
  mockState.stderrChunks = [];
  mockState.env = {};
  mockState.unlinkSpy = vi.fn();
}

function setRecentFile(name, size = 30000) {
  mockState.readdirResult.push(name);
  mockState.statMap[name] = { size, mtimeMs: Date.now(), isFile: true };
}

let mainFn;
let classifyFn;
let listFn;
let stderrSpy;
const originalEnv = { ...process.env };

beforeEach(async () => {
  resetState();
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    mockState.stderrChunks.push(String(chunk));
    return true;
  });
  // Clean env for each test (preserve unrelated ones by restoring at the end).
  delete process.env.ARTIBOT_IMAGE_CLEANUP;
  if (!mainFn) {
    const mod = await import('../../scripts/hooks/image-cleanup.js');
    mainFn = mod.main;
    classifyFn = mod.classifyCandidate;
    listFn = mod.listCandidates;
  }
});

afterEach(() => {
  stderrSpy?.mockRestore();
  vi.clearAllMocks();
  Object.assign(process.env, originalEnv);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('image-cleanup', () => {
  describe('pattern matching — listCandidates()', () => {
    it('matches Claude Code auto-save filenames only', () => {
      mockState.readdirResult = [
        'image.png',
        'image copy.png',
        'image copy 3.png',
        'screenshot.png',      // not matched — different name
        'Image.png',           // not matched — case-sensitive
        'image_copy.png',      // not matched — underscore instead of space
        'my-image.png',        // not matched — prefix
      ];
      const matches = listFn('/fake/cwd');
      expect(matches).toEqual([
        'image.png',
        'image copy.png',
        'image copy 3.png',
      ]);
    });
  });

  describe('classifyCandidate()', () => {
    const now = 1_700_000_000_000;

    it('returns "delete" for small, recent files', () => {
      mockState.statMap['image.png'] = { size: 50_000, mtimeMs: now - 1000, isFile: true };
      expect(classifyFn('/fake/cwd/image.png', now)).toBe('delete');
    });

    it('returns "skip-size" for oversized files (>10MB)', () => {
      mockState.statMap['image.png'] = { size: 15 * 1024 * 1024, mtimeMs: now, isFile: true };
      expect(classifyFn('/fake/cwd/image.png', now)).toBe('skip-size');
    });

    it('returns "skip-age" for files older than 48h', () => {
      mockState.statMap['image.png'] = {
        size: 50_000,
        mtimeMs: now - 72 * 60 * 60 * 1000,
        isFile: true,
      };
      expect(classifyFn('/fake/cwd/image.png', now)).toBe('skip-age');
    });

    it('returns "skip-missing" when stat throws', () => {
      expect(classifyFn('/fake/cwd/missing.png', now)).toBe('skip-missing');
    });
  });

  describe('main() — sweep flow', () => {
    it('deletes matching recent untracked files and reports stderr', () => {
      setRecentFile('image.png', 30_000);
      setRecentFile('image copy.png', 40_000);

      const summary = mainFn({ cwd: '/fake/cwd' });

      expect(summary.disabled).toBe(false);
      expect(summary.deleted.sort()).toEqual(['image copy.png', 'image.png']);
      expect(summary.skipped).toEqual([]);
      expect(mockState.stderrChunks.join('')).toContain('removed 2');
    });

    it('skips files tracked by git', () => {
      setRecentFile('image.png', 30_000);
      // 후속 19 (#9): ls-tree 는 이제 -z 로 부른다 → NUL 구분 픽스처.
      mockState.execSyncImpl = () => 'image.png\0README.md\0';

      const summary = mainFn({ cwd: '/fake/cwd' });

      expect(summary.deleted).toEqual([]);
      expect(summary.skipped).toEqual([{ name: 'image.png', reason: 'tracked-by-git' }]);
    });

    it('skips files larger than 10MB even if they match the pattern', () => {
      setRecentFile('image.png', 20 * 1024 * 1024);

      const summary = mainFn({ cwd: '/fake/cwd' });

      expect(summary.deleted).toEqual([]);
      expect(summary.skipped[0]).toMatchObject({ name: 'image.png', reason: 'skip-size' });
    });

    it('skips files older than 48h', () => {
      mockState.readdirResult.push('image.png');
      mockState.statMap['image.png'] = {
        size: 30_000,
        mtimeMs: Date.now() - 72 * 60 * 60 * 1000,
        isFile: true,
      };

      const summary = mainFn({ cwd: '/fake/cwd' });

      expect(summary.deleted).toEqual([]);
      expect(summary.skipped[0]).toMatchObject({ name: 'image.png', reason: 'skip-age' });
    });

    it('reports delete-failed with errno when unlink throws', () => {
      setRecentFile('image.png', 30_000);
      mockState.unlinkFailures.add('image.png');

      const summary = mainFn({ cwd: '/fake/cwd' });

      expect(summary.deleted).toEqual([]);
      expect(summary.skipped[0].reason).toMatch(/^delete-failed:/);
    });

    it('is a no-op when no candidate files exist', () => {
      const summary = mainFn({ cwd: '/fake/cwd' });

      expect(summary.deleted).toEqual([]);
      expect(summary.skipped).toEqual([]);
      expect(mockState.stderrChunks).toEqual([]);
    });

    it('is disabled when ARTIBOT_IMAGE_CLEANUP=off', () => {
      process.env.ARTIBOT_IMAGE_CLEANUP = 'off';
      setRecentFile('image.png', 30_000);

      const summary = mainFn({ cwd: '/fake/cwd' });

      expect(summary.disabled).toBe(true);
      expect(summary.deleted).toEqual([]);
    });

    it('is disabled when ~/.claude/artibot/config.json has imageCleanup:false', () => {
      mockState.existsSyncResults = { 'config.json': true };
      mockState.readFileSyncImpl = (p) => {
        if (String(p).includes('config.json')) {
          return JSON.stringify({ imageCleanup: false });
        }
        throw new Error('ENOENT');
      };
      setRecentFile('image.png', 30_000);

      const summary = mainFn({ cwd: '/fake/cwd' });

      expect(summary.disabled).toBe(true);
      expect(summary.deleted).toEqual([]);
    });

    // -------------------------------------------------------------------
    // C-1 fail-closed on malformed config (Phase 2c P0 fix)
    // -------------------------------------------------------------------
    it('fails closed (disabled=true) and warns to stderr when config JSON is malformed', () => {
      mockState.existsSyncResults = { 'config.json': true };
      mockState.readFileSyncImpl = (p) => {
        if (String(p).includes('config.json')) {
          // Truncated/invalid JSON — the kind a user might leave behind mid-edit.
          return '{ "imageCleanup": fal';
        }
        throw new Error('ENOENT');
      };
      setRecentFile('image.png', 30_000);

      const summary = mainFn({ cwd: '/fake/cwd' });

      expect(summary.disabled).toBe(true);
      expect(summary.deleted).toEqual([]);
      // WARN must reach stderr so operators see the silent disable.
      const stderr = mockState.stderrChunks.join('');
      expect(stderr).toMatch(/WARN: malformed config/);
    });

    it('fails closed when readFileSync throws on a config that exists', () => {
      mockState.existsSyncResults = { 'config.json': true };
      mockState.readFileSyncImpl = (p) => {
        if (String(p).includes('config.json')) {
          const e = new Error('EACCES: permission denied');
          e.code = 'EACCES';
          throw e;
        }
        throw new Error('ENOENT');
      };
      setRecentFile('image.png', 30_000);

      const summary = mainFn({ cwd: '/fake/cwd' });

      expect(summary.disabled).toBe(true);
      expect(summary.deleted).toEqual([]);
      expect(mockState.stderrChunks.join('')).toMatch(/WARN: malformed config/);
    });
  });
});

// ---------------------------------------------------------------------------
// trackedFilesAtRoot — git 경로 출력 디코딩 (후속 19 #9, image-cleanup.js:85)
// ---------------------------------------------------------------------------
//
// 정직한 기록: **이 자리에는 재현 가능한 결함이 없다.** 후보 목록이
// CLAUDE_PASTE_PATTERN = /^image(?: copy(?: \d+)?)?\.png$/ 로 못박힌 순수
// ASCII 허용목록이라, 비-ASCII 이름도 앞뒤 공백 이름도 애초에 후보가 될 수
// 없다. 따라서 core.quotepath C-quote 축도 .trim() 축도 결과를 바꾸지 않는다
// — 오너가 제외한 #7(존재 판정)·#10(개수만) 과 같은 부류다.
//
// 그럼에도 -z 로 옮기는 이유는 두 가지뿐이고, 둘 다 예방적이다.
//   (1) 후보 패턴이 언젠가 넓어지면 그때부터 C-quote 가 파일을 **지운다**.
//       tracked 집합에서 빠진 이름은 "추적 안 됨"으로 읽혀 unlinkSync 로 간다.
//   (2) 나머지 11자리와 같은 형태를 유지해 다음 독자가 예외를 추론하지 않게.
//
// 그래서 아래는 (a) 명령 계약과 (b) 기존 행동 회귀만 못박는다. 행동 변화를
// 주장하지 않는다.
describe('trackedFilesAtRoot — 경로 출력 계약 (후속 19 #9)', () => {
  it('(a) ls-tree 에 -z 를 넘긴다', () => {
    const seen = [];
    mockState.execSyncImpl = (cmd) => { seen.push(cmd); return ''; };
    setRecentFile('image.png', 30_000);

    mainFn({ cwd: '/fake/cwd' });

    // 자기검증: 호출이 없으면 아래 단언은 공허하다.
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.some((c) => c.includes('ls-tree') && c.includes('-z'))).toBe(true);
  });

  it('(b) NUL 구분 목록으로도 추적 파일을 그대로 건너뛴다(회귀)', () => {
    setRecentFile('image.png', 30_000);
    mockState.execSyncImpl = () => 'image.png\0README.md\0';

    const summary = mainFn({ cwd: '/fake/cwd' });

    expect(summary.deleted).toEqual([]);
    expect(summary.skipped).toEqual([{ name: 'image.png', reason: 'tracked-by-git' }]);
  });

  it('(b) 추적 목록에 없으면 여전히 지운다(회귀)', () => {
    setRecentFile('image.png', 30_000);
    mockState.execSyncImpl = () => 'README.md\0';

    const summary = mainFn({ cwd: '/fake/cwd' });

    expect(summary.deleted).toEqual(['image.png']);
  });

  it('하위 경로 항목은 루트 집합에 넣지 않는다(회귀)', () => {
    setRecentFile('image.png', 30_000);
    // ls-tree 는 비재귀라 디렉터리는 이름만 나온다. 슬래시가 든 항목이
    // 섞여 들어와도 루트 파일로 오인하면 안 된다.
    mockState.execSyncImpl = () => 'src\0src/image.png\0';

    const summary = mainFn({ cwd: '/fake/cwd' });

    expect(summary.deleted).toEqual(['image.png']);
  });

  it('꼬리 NUL 이 빈 이름으로 새지 않는다', () => {
    setRecentFile('image.png', 30_000);
    mockState.execSyncImpl = () => 'README.md\0\0';

    const summary = mainFn({ cwd: '/fake/cwd' });

    expect(summary.deleted).toEqual(['image.png']);
    expect(summary.skipped).toEqual([]);
  });
});
