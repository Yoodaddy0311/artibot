import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * repo-root-cache.js — process-scoped memoize for `git rev-parse`.
 *
 * Spec from perf-auditor A1:
 *   - first call → spawns child process
 *   - second call (same cwd) → cache hit (no child process)
 *   - different cwd → separate cache entry (no cross-pollination)
 *   - __resetForTest() clears all memoize state
 */

const execMock = vi.fn();

vi.mock('node:child_process', () => ({
  execSync: (...args) => execMock(...args),
}));

let getRepoRoot;
let getHeadSha;
let __resetForTest;

beforeEach(async () => {
  execMock.mockReset();
  if (!getRepoRoot) {
    ({ getRepoRoot, getHeadSha, __resetForTest } = await import(
      '../../lib/git/repo-root-cache.js'
    ));
  }
  __resetForTest();
});

describe('repo-root-cache', () => {
  describe('getRepoRoot()', () => {
    it('returns the trimmed git rev-parse output on first call', () => {
      execMock.mockReturnValueOnce('/repo/root\n');
      expect(getRepoRoot('/repo/root')).toBe('/repo/root');
      expect(execMock).toHaveBeenCalledTimes(1);
    });

    it('memoizes the result for repeated calls with the same cwd', () => {
      execMock.mockReturnValueOnce('/repo/root\n');
      const first = getRepoRoot('/repo/root');
      const second = getRepoRoot('/repo/root');
      const third = getRepoRoot('/repo/root');
      expect(first).toBe('/repo/root');
      expect(second).toBe('/repo/root');
      expect(third).toBe('/repo/root');
      // Cache hit on calls 2 + 3 — exec must fire only once.
      expect(execMock).toHaveBeenCalledTimes(1);
    });

    it('isolates cache entries per cwd', () => {
      execMock
        .mockReturnValueOnce('/repo/a\n')
        .mockReturnValueOnce('/repo/b\n');
      expect(getRepoRoot('/repo/a')).toBe('/repo/a');
      expect(getRepoRoot('/repo/b')).toBe('/repo/b');
      // Hit cache on follow-up calls
      expect(getRepoRoot('/repo/a')).toBe('/repo/a');
      expect(getRepoRoot('/repo/b')).toBe('/repo/b');
      expect(execMock).toHaveBeenCalledTimes(2);
    });

    it('caches null when git fails, and does not re-probe', () => {
      execMock.mockImplementationOnce(() => {
        throw new Error('not a git repository');
      });
      expect(getRepoRoot('/not/a/repo')).toBeNull();
      // Second call must not retry — cached null
      expect(getRepoRoot('/not/a/repo')).toBeNull();
      expect(execMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('getHeadSha()', () => {
    it('returns the trimmed HEAD sha on first call', () => {
      execMock.mockReturnValueOnce('abc123def\n');
      expect(getHeadSha('/repo/root')).toBe('abc123def');
      expect(execMock).toHaveBeenCalledTimes(1);
    });

    it('memoizes HEAD sha per cwd', () => {
      execMock.mockReturnValueOnce('deadbeef\n');
      getHeadSha('/repo/root');
      getHeadSha('/repo/root');
      getHeadSha('/repo/root');
      expect(execMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('__resetForTest()', () => {
    it('clears both repoRoot and headSha caches', () => {
      execMock
        .mockReturnValueOnce('/repo/root\n')
        .mockReturnValueOnce('sha-1\n');
      getRepoRoot('/repo/root');
      getHeadSha('/repo/root');
      expect(execMock).toHaveBeenCalledTimes(2);

      __resetForTest();

      execMock
        .mockReturnValueOnce('/repo/root\n')
        .mockReturnValueOnce('sha-1\n');
      getRepoRoot('/repo/root');
      getHeadSha('/repo/root');
      expect(execMock).toHaveBeenCalledTimes(4);
    });
  });
});
