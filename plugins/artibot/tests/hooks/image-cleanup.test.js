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
      mockState.execSyncImpl = () => 'image.png\nREADME.md\n';

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
  });
});
